import { describe, it, expect } from 'vitest';
import {
  ForbiddenException,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import {
  BookingAuthGuard,
  DESK_ONLY_KEY,
  PUBLIC_KEY,
} from '../../auth/booking-auth.guard';
import type { Actor } from '../../auth/actor';
import type { TokenVerifier } from '../../auth/token-verifier.service';
import type { ActorKind } from '@domain/booking/lifecycle';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { SeriesController } from './series.controller';
import { BookingSeriesController } from './booking-series.controller';

/**
 * THE SERIES ROUTES ARE THE SALON'S, NOT THE CUSTOMER'S.
 *
 * Both controllers were undecorated, and an undecorated route admits any
 * signed-in caller. Create took `customerId` from the body and every other
 * route acted on any series id, so a customer token could make a series for
 * someone else, read anyone's panel, or pause, end, skip, re-pattern or
 * materialise it.
 *
 * Run through the REAL guard with the REAL controllers' metadata, route by
 * route, so a method-level override that re-opened one route would fail here
 * even though the class is decorated.
 */

interface Route {
  readonly label: string;
  readonly handler: object;
  readonly cls: object;
}

function routesOf(cls: { readonly name: string; readonly prototype: object }) {
  const proto = cls.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name] as object)
    .filter((fn) => Reflect.getMetadata(PATH_METADATA, fn) !== undefined)
    .map((fn): Route => {
      const verb = RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, fn) as number
      ] as string;
      const path = String(Reflect.getMetadata(PATH_METADATA, fn));
      return { label: `${cls.name} ${verb} ${path}`, handler: fn, cls };
    });
}

const ROUTES: readonly Route[] = [
  ...routesOf(SeriesController),
  ...routesOf(BookingSeriesController),
];

const CONTROLLERS = [
  ['SeriesController', SeriesController],
  ['BookingSeriesController', BookingSeriesController],
] as const;

const actorOf = (kind: ActorKind): Actor => ({
  id: 'a-1',
  kind,
  branchId: null,
  tenantId: null,
});

/** A verifier that hands back whatever kind the test asked for. */
const verifierFor = (kind: ActorKind): TokenVerifier =>
  ({
    verify: () => Promise.resolve(actorOf(kind)),
  }) as unknown as TokenVerifier;

const run = async (
  kind: ActorKind,
  route: Route,
  headers: Record<string, string> = { authorization: 'Bearer t' },
): Promise<{ allowed: boolean; actor: Actor | undefined }> => {
  const guard = new BookingAuthGuard(
    verifierFor(kind),
    new Reflector(),
    new TenantContext(),
  );
  const request: { headers: Record<string, string>; actor?: Actor } = {
    headers,
  };
  const ctx = {
    getHandler: () => route.handler,
    getClass: () => route.cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const allowed = await guard.canActivate(ctx);
  return { allowed, actor: request.actor };
};

describe('the routes under test', () => {
  it('finds every series route, so the checks below are not testing nothing', () => {
    // A new route is covered by the class decorator anyway. This list only
    // proves the enumeration works; it is a floor, not a ceiling.
    expect(ROUTES.map((r) => r.label)).toEqual(
      expect.arrayContaining([
        'SeriesController POST /',
        'SeriesController GET :id',
        'SeriesController GET :id/occurrences',
        'SeriesController POST :id/materialise',
        'SeriesController POST :id/pause',
        'SeriesController POST :id/resume',
        'SeriesController POST :id/end',
        'SeriesController POST :id/occurrences/:occurrenceId/skip',
        'SeriesController POST :id/pattern',
        'SeriesController GET :id/occurrences/:occurrenceId/edit-scope',
        'BookingSeriesController POST preview',
        'BookingSeriesController GET :id',
      ]),
    );
  });

  it('SeriesController serves both prefixes from the one decorated class', () => {
    // /v1/series and /v1/bookings/series-admin are the same controller, so
    // the class decorator closes both. The desk calls series-admin.
    expect(Reflect.getMetadata(PATH_METADATA, SeriesController)).toEqual([
      'series',
      'bookings/series-admin',
    ]);
  });
});

describe('both series controllers are desk only', () => {
  it.each(CONTROLLERS)('%s carries @DeskOnly() on the class', (_name, cls) => {
    expect(Reflect.getMetadata(DESK_ONLY_KEY, cls)).toBe(true);
  });

  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s: no method-level override re-opens it',
    (_label, route) => {
      // Exactly what the guard reads. A method-level @Public() or a
      // SetMetadata(DESK_ONLY_KEY, false) would win over the class here.
      const reflector = new Reflector();
      const targets = [route.handler as () => unknown, route.cls as never];
      expect(reflector.getAllAndOverride(DESK_ONLY_KEY, targets)).toBe(true);
      expect(reflector.getAllAndOverride(PUBLIC_KEY, targets)).not.toBe(true);
    },
  );
});

describe('a customer is refused on every series route', () => {
  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s: 403',
    async (_label, route) => {
      const refused = run('customer', route);
      await expect(refused).rejects.toThrow(ForbiddenException);
      await expect(refused).rejects.toThrow(
        'A customer may not work the salon desk.',
      );
    },
  );
});

describe('the salon works exactly as before', () => {
  const cases = ROUTES.flatMap((r) =>
    (['staff', 'manager', 'system'] as const).map(
      (kind) => [r.label, kind, r] as const,
    ),
  );

  it.each(cases)('%s: %s is admitted', async (_label, kind, route) => {
    const { allowed, actor } = await run(kind, route);
    expect(allowed).toBe(true);
    // The handler still gets the actor, as on every other guarded route.
    expect(actor?.kind).toBe(kind);
  });

  it.each(ROUTES.map((r) => [r.label, r] as const))(
    '%s: no token is still a 401, checked before the kind',
    async (_label, route) => {
      await expect(run('staff', route, {})).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );
});

describe('/docs shows the refusal', () => {
  it.each(CONTROLLERS)('%s declares the 403 in swagger', (_name, cls) => {
    const keys = (Reflect.getMetadataKeys(cls) as unknown[]).map(String);
    expect(keys.some((k) => k.toLowerCase().includes('response'))).toBe(true);
  });
});
