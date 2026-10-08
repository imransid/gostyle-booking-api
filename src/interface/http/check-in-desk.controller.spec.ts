import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  CheckInDeskController,
  ReceptionCheckInController,
} from './check-in-desk.controller';
import { SelfCheckInEnabledGuard } from './self-check-in.flag';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { BookingScope } from './booking-scope';
import { DESK_ONLY_KEY } from '../../auth/booking-auth.guard';
import type { Actor } from '../../auth/actor';

/**
 * The desk's self check-in routes. The scope check is the real BookingScope;
 * only its database lookup is faked. STAFF_SCOPE_V1 is left UNSET: these
 * routes must refuse another salon's booking whatever it says (D2).
 */

const LOOK_CHANGE = 'f2a9882b-c822-4107-b650-29af2e303c24';
const ROMONI = '3c457f1c-e7d4-4c9b-b877-27146c834608';
const BRANCH_A = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';
const BRANCH_B = 'b67fad90-6064-446a-8d80-411347c1f929';
const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';

const desk = (over: Partial<Actor> = {}): Actor => ({
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'staff',
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

function lookupOf(tenantId: string | null, branchId = BRANCH_A) {
  return {
    byId: vi.fn(() =>
      Promise.resolve({
        id: BOOKING,
        code: 'GS-1',
        customerId: '11111111-1111-4111-8111-111111111111',
        tenantId,
        branchId,
      }),
    ),
    byCode: vi.fn(() => Promise.resolve(null)),
  };
}

function handler() {
  return {
    approve: vi.fn(() => Promise.resolve({ request: {}, checkIn: {} })),
    reject: vi.fn(() => Promise.resolve({ request: {} })),
    reception: vi.fn(),
  };
}

beforeEach(() => {
  delete process.env.STAFF_SCOPE_V1;
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('the desk routes are behind the flag, desk only', () => {
  it.each([CheckInDeskController, ReceptionCheckInController])(
    '%o',
    (controller) => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[],
      ).toContain(SelfCheckInEnabledGuard);
      expect(Reflect.getMetadata(DESK_ONLY_KEY, controller)).toBe(true);
    },
  );

  it('approve and reject replay a retried tap (Idempotency-Key)', () => {
    expect(
      Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        CheckInDeskController,
      ) as unknown[],
    ).toContain(IdempotentInterceptor);
  });
});

describe('approve and reject: scope always on, STAFF_SCOPE_V1 unset', () => {
  it.each([
    ['another tenant', ROMONI, BRANCH_A],
    ['another branch', LOOK_CHANGE, BRANCH_B],
    ['no tenant on the booking', null, BRANCH_A],
  ])('%s: 404 "No such booking", nothing runs', async (_, tenant, branch) => {
    const h = handler();
    const c = new CheckInDeskController(
      new BookingScope(lookupOf(tenant, branch) as never),
      h as never,
    );
    await expect(c.approve(BOOKING, desk())).rejects.toThrow(
      new NotFoundException('No such booking'),
    );
    await expect(
      c.reject(BOOKING, { reason: 'Not here' }, desk()),
    ).rejects.toThrow(new NotFoundException('No such booking'));
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
  });

  it('its own salon: approve runs as this desk', async () => {
    const h = handler();
    const c = new CheckInDeskController(
      new BookingScope(lookupOf(LOOK_CHANGE) as never),
      h as never,
    );
    await c.approve(BOOKING, desk());
    expect(h.approve).toHaveBeenCalledWith({
      bookingId: BOOKING,
      actor: 'staff',
      actorId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('its own salon: reject hands the reason down as typed', async () => {
    const h = handler();
    const c = new CheckInDeskController(
      new BookingScope(lookupOf(LOOK_CHANGE) as never),
      h as never,
    );
    await c.reject(
      BOOKING,
      { reason: ' Not here ' },
      desk({ kind: 'manager' }),
    );
    expect(h.reject).toHaveBeenCalledWith({
      bookingId: BOOKING,
      actor: 'manager',
      actorId: '22222222-2222-4222-8222-222222222222',
      reason: ' Not here ',
    });
  });
});

describe('the reception list: scope always on', () => {
  const entry = (
    name: string,
    tenantId: string | null,
    branchId = BRANCH_A,
  ) => ({
    item: { name },
    scope: { customerId: 'c', tenantId, branchId },
  });

  it('keeps its own salon’s lines and sends only the items', async () => {
    const h = handler();
    h.reception.mockResolvedValue({
      waiting: [entry('mine', LOOK_CHANGE), entry('romoni', ROMONI)],
      needsDecision: [entry('fixture', null), entry('mine too', LOOK_CHANGE)],
    });
    const c = new ReceptionCheckInController(
      new BookingScope(lookupOf(null) as never),
      h as never,
    );
    await expect(c.list(BRANCH_A, desk())).resolves.toEqual({
      branchId: BRANCH_A,
      waiting: [{ name: 'mine' }],
      needsDecision: [{ name: 'mine too' }],
    });
    expect(h.reception).toHaveBeenCalledWith(BRANCH_A);
  });

  it('another tenant’s branch, named by a token with no branch, reads empty', async () => {
    const h = handler();
    h.reception.mockResolvedValue({
      waiting: [entry('romoni', ROMONI, BRANCH_B)],
      needsDecision: [entry('romoni 2', ROMONI, BRANCH_B)],
    });
    const c = new ReceptionCheckInController(
      new BookingScope(lookupOf(null) as never),
      h as never,
    );
    await expect(
      c.list(BRANCH_B, desk({ kind: 'manager', branchId: null })),
    ).resolves.toEqual({ branchId: BRANCH_B, waiting: [], needsDecision: [] });
  });
});
