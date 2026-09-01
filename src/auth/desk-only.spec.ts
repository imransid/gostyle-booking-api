import { describe, it, expect } from 'vitest';
import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { BookingAuthGuard, DESK_ONLY_KEY } from './booking-auth.guard';
import { DeskOnly } from './desk-only.decorator';
import { Public } from './public.decorator';
import type { Actor } from './actor';
import type { TokenVerifier } from './token-verifier.service';
import type { ActorKind } from '@domain/booking/lifecycle';

/**
 * POST /v1/walk-ins returned `500 Internal server error` to any customer
 * token, and GET/seat/leave returned 200 -- a customer could read the whole
 * waiting room by name, seat a stranger and remove one.
 *
 * The 500 was the visible half and the easy half. This file guards the other
 * half: that the refusal is a 403 the caller can act on, that it happens
 * before the handler runs, and that a customer token is refused on EVERY
 * method of a decorated controller rather than only the one that crashed.
 */

@Controller('desk')
@DeskOnly()
class DeskController {
  @Get('queue')
  queue(this: void): string {
    return 'queue';
  }
}

@Controller('open')
class OpenController {
  @Get('anyone')
  anyone(this: void): string {
    return 'anyone';
  }

  @Public()
  @Get('public')
  free(this: void): string {
    return 'free';
  }
}

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

const contextFor = (
  handler: object,
  cls: object,
  headers: Record<string, string>,
): { ctx: ExecutionContext; request: { actor?: Actor } } => {
  const request: { headers: Record<string, string>; actor?: Actor } = {
    headers,
  };
  const ctx = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
};

const run = (
  kind: ActorKind,
  handler: object,
  cls: object,
  headers: Record<string, string> = { authorization: 'Bearer t' },
): Promise<boolean> => {
  const guard = new BookingAuthGuard(verifierFor(kind), new Reflector());
  const { ctx } = contextFor(handler, cls, headers);
  return guard.canActivate(ctx);
};

const deskHandler = DeskController.prototype.queue;
const plainHandler = OpenController.prototype.anyone;
const publicHandler = OpenController.prototype.free;

describe('@DeskOnly() refuses a customer', () => {
  it('throws Forbidden, not Unauthorized and not a 500', async () => {
    // The bug this file exists for: the caller must be told they are the
    // wrong KIND of caller. A 401 would send them off to sign in again,
    // which cannot help, and a 500 says nothing at all.
    await expect(run('customer', deskHandler, DeskController)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('says why, naming the actor and the act', async () => {
    await expect(run('customer', deskHandler, DeskController)).rejects.toThrow(
      'A customer may not work the salon desk.',
    );
  });

  it('refuses from the CLASS decorator, so every method is covered', () => {
    // walk-ins was decorated on the controller rather than on join(), because
    // seat and leave were the worse holes. Method-level metadata is absent
    // here and the guard still has to find it.
    expect(Reflect.getMetadata(DESK_ONLY_KEY, deskHandler)).toBeUndefined();
    expect(Reflect.getMetadata(DESK_ONLY_KEY, DeskController)).toBe(true);
  });
});

describe('@DeskOnly() lets the salon through', () => {
  it.each<ActorKind>(['staff', 'manager', 'system'])(
    'admits %s',
    async (kind) => {
      await expect(run(kind, deskHandler, DeskController)).resolves.toBe(true);
    },
  );

  it('still puts the actor on the request for the handler to read', async () => {
    const guard = new BookingAuthGuard(verifierFor('staff'), new Reflector());
    const { ctx, request } = contextFor(deskHandler, DeskController, {
      authorization: 'Bearer t',
    });
    await guard.canActivate(ctx);
    expect(request.actor?.kind).toBe('staff');
  });
});

describe('the rest of the surface is unchanged', () => {
  it('an undecorated route still admits a customer', async () => {
    // Closed by default means AUTHENTICATED by default, not staff-only.
    // A customer holds and books; only the desk endpoints are narrowed.
    await expect(run('customer', plainHandler, OpenController)).resolves.toBe(
      true,
    );
  });

  it('a missing token is still a 401, checked before the kind', async () => {
    await expect(
      run('customer', deskHandler, DeskController, {}),
    ).rejects.toThrow('Missing bearer token');
  });

  it('@Public() still short-circuits', async () => {
    await expect(
      run('customer', publicHandler, OpenController, {}),
    ).resolves.toBe(true);
  });
});

describe('@DeskOnly() documents the 403 as well as enforcing it', () => {
  it('leaves swagger response metadata, so /docs shows the refusal', () => {
    // Same failure mode @Public() had: enforcement and documentation drift,
    // nothing fails, and a client author meets the 403 in production.
    const added = (Reflect.getMetadataKeys(deskHandler) as unknown[])
      .map(String)
      .concat(
        (Reflect.getMetadataKeys(DeskController) as unknown[]).map(String),
      );
    expect(
      added.some((k) => k.toLowerCase().includes('response')),
      '@DeskOnly() must also declare ApiForbiddenResponse, or /docs will not ' +
        'mention the 403 it now returns.',
    ).toBe(true);
  });
});
