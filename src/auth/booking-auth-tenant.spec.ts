import { describe, it, expect, vi } from 'vitest';
import {
  Controller,
  Get,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { BookingAuthGuard } from './booking-auth.guard';
import { Public } from './public.decorator';
import type { Actor } from './actor';
import type { TokenVerifier } from './token-verifier.service';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';

/**
 * A desk user with a perfectly good token got no tenant, because the tenant
 * was read from X-Tenant-Id and nowhere else. The platform roster call is
 * tenant-scoped, so it was refused, and the calendar drew six fixture
 * stylists at a branch with three real ones.
 *
 * This file proves the guard fills the tenant from the verified token, and
 * only when the header gave none. Each test runs the guard INSIDE a scope,
 * the way TenantMiddleware wraps it in a real request.
 */

@Controller('calendar')
class CalendarController {
  @Get('day')
  day(this: void): string {
    return 'day';
  }

  @Public()
  @Get('open')
  open(this: void): string {
    return 'open';
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111';

const staff = (tenantId: string | null): Actor => ({
  id: 'staff-1',
  kind: 'staff',
  branchId: null,
  tenantId,
});

const customer: Actor = {
  id: 'customer-1',
  kind: 'customer',
  branchId: null,
  tenantId: null,
};

/** A verifier that answers with this actor, after an optional delay. */
const verifierFor = (actor: Actor, delayMs = 0): TokenVerifier =>
  ({
    verify: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return actor;
    },
  }) as unknown as TokenVerifier;

const refusingVerifier = {
  verify: () => Promise.reject(new UnauthorizedException('Invalid token')),
} as unknown as TokenVerifier;

const contextFor = (handler: object, headers: Record<string, string>) =>
  ({
    getHandler: () => handler,
    getClass: () => CalendarController,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

const bearer = { authorization: 'Bearer t' };
const day = CalendarController.prototype.day;
const open = CalendarController.prototype.open;

/**
 * Runs the guard in a request scope opened with `header`, as the middleware
 * would, and reports the tenant the handler would then read.
 */
const tenantAfterGuard = (
  tenants: TenantContext,
  verifier: TokenVerifier,
  header: string | null,
): Promise<string | null> =>
  tenants.run(header, async () => {
    const guard = new BookingAuthGuard(verifier, new Reflector(), tenants);
    await guard.canActivate(contextFor(day, bearer));
    return tenants.current();
  });

describe('the guard fills the tenant from the token', () => {
  it('uses the staff token tenant when no header was sent', async () => {
    const tenants = new TenantContext();
    await expect(
      tenantAfterGuard(tenants, verifierFor(staff(TENANT)), null),
    ).resolves.toBe(TENANT);
  });

  it('keeps the header when one was sent, even against the token', async () => {
    const tenants = new TenantContext();
    await expect(
      tenantAfterGuard(tenants, verifierFor(staff(TENANT)), 'header-tenant'),
    ).resolves.toBe('header-tenant');
  });

  it('leaves a customer with no tenant, as before', async () => {
    const tenants = new TenantContext();
    await expect(
      tenantAfterGuard(tenants, verifierFor(customer), null),
    ).resolves.toBeNull();
  });

  it('leaves a staff token that names no tenant with none', async () => {
    const tenants = new TenantContext();
    await expect(
      tenantAfterGuard(tenants, verifierFor(staff(null)), null),
    ).resolves.toBeNull();
  });

  it('fills nothing from a token that fails verification', async () => {
    const tenants = new TenantContext();
    await tenants.run(null, async () => {
      const guard = new BookingAuthGuard(
        refusingVerifier,
        new Reflector(),
        tenants,
      );
      await expect(guard.canActivate(contextFor(day, bearer))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(tenants.current()).toBeNull();
    });
  });
});

/**
 * The new-booking panel's availability calls are @Public(), and the guard
 * used to return before it looked at the token at all. A desk user there got
 * no tenant, and the panel offered two fixture stylists while the calendar
 * drew the three real ones.
 */
describe('a @Public() route reads a token when one is sent', () => {
  /** Runs the guard on the public route and reports what the handler sees. */
  const publicCall = (
    verifier: TokenVerifier,
    headers: Record<string, string>,
  ) => {
    const tenants = new TenantContext();
    const request: { headers: Record<string, string>; actor?: Actor } = {
      headers,
    };
    const ctx = {
      getHandler: () => open,
      getClass: () => CalendarController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return tenants.run(null, async () => {
      const guard = new BookingAuthGuard(verifier, new Reflector(), tenants);
      const allowed = await guard.canActivate(ctx);
      return { allowed, actor: request.actor, tenant: tenants.current() };
    });
  };

  it('fills the tenant and the actor from a valid staff token', async () => {
    const seen = await publicCall(verifierFor(staff(TENANT)), bearer);
    expect(seen.allowed).toBe(true);
    expect(seen.tenant).toBe(TENANT);
    expect(seen.actor?.id).toBe('staff-1');
  });

  it('stays anonymous with no token, and never asks the verifier', async () => {
    const verify = vi.fn();
    const seen = await publicCall({ verify } as unknown as TokenVerifier, {});
    expect(seen).toEqual({ allowed: true, actor: undefined, tenant: null });
    expect(verify).not.toHaveBeenCalled();
  });

  it('serves a token that fails verification anonymously, not as a 401', async () => {
    await expect(publicCall(refusingVerifier, bearer)).resolves.toEqual({
      allowed: true,
      actor: undefined,
      tenant: null,
    });
  });

  it('serves anonymously when the token cannot be checked at all (503)', async () => {
    // Consumer auth down, or no staff secret: a guarded route answers 503.
    // A customer browsing times must not lose the page to that.
    const unavailable = {
      verify: () =>
        Promise.reject(new ServiceUnavailableException('consumer auth down')),
    } as unknown as TokenVerifier;
    await expect(publicCall(unavailable, bearer)).resolves.toEqual({
      allowed: true,
      actor: undefined,
      tenant: null,
    });
  });
});

describe('requests in flight together', () => {
  it('each sees its own tenant, however their verifications interleave', async () => {
    // One guard instance, as in production: APP_GUARD is a singleton, so
    // the only thing keeping these apart is the per-request slot. The slow
    // verifier finishes LAST, after both others have filled theirs.
    const tenants = new TenantContext();
    const verifier = {
      verify: async (token: string): Promise<Actor> => {
        const [who, delay] = token.split(':') as [string, string];
        await new Promise((r) => setTimeout(r, Number(delay)));
        return who === 'customer' ? customer : staff(`tenant-${who}`);
      },
    } as unknown as TokenVerifier;
    const guard = new BookingAuthGuard(verifier, new Reflector(), tenants);

    const request = (token: string, header: string | null) =>
      tenants.run(header, async () => {
        await guard.canActivate(
          contextFor(day, { authorization: `Bearer ${token}` }),
        );
        // Yield once more so every other request has run its fill first.
        await new Promise((r) => setTimeout(r, 15));
        return tenants.current();
      });

    const [slow, fast, headed, cust] = await Promise.all([
      request('slow:10', null),
      request('fast:1', null),
      request('headed:5', 'header-tenant'),
      request('customer:3', null),
    ]);

    expect(slow).toBe('tenant-slow');
    expect(fast).toBe('tenant-fast');
    expect(headed).toBe('header-tenant');
    expect(cust).toBeNull();
  });
});
