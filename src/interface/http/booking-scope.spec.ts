import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import { BookingScope, type BookingRef } from './booking-scope';
import type { Actor } from '../../auth/actor';
import type { ScopedBookingRow } from '@infrastructure/persistence/booking-scope.repository';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * The scope check at the edge: the real BookingScope and the real rule,
 * over a faked lookup. STAFF_SCOPE_V1 is set per test and removed after.
 */

const LOOK_CHANGE = 'f2a9882b-c822-4107-b650-29af2e303c24';
const ROMONI = '3c457f1c-e7d4-4c9b-b877-27146c834608';
const BRANCH_A = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';
const BRANCH_B = 'b67fad90-6064-446a-8d80-411347c1f929';
const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE = 'POST /v1/bookings/:id/cancel';

const row = (over: Partial<ScopedBookingRow> = {}): ScopedBookingRow => ({
  id: BOOKING,
  code: 'GS-1234',
  customerId: CUSTOMER,
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

const staff = (over: Partial<Actor> = {}): Actor => ({
  id: STAFF_ID,
  kind: 'staff',
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

const customer = (id = CUSTOMER): Actor => ({
  id,
  kind: 'customer',
  tenantId: null,
  branchId: null,
});

const byId: BookingRef = { bookingId: BOOKING };
const byCode: BookingRef = { bookingCode: 'GS-1234' };

let warn: MockInstance<Logger['warn']>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.STAFF_SCOPE_V1;
  vi.restoreAllMocks();
});

function scope(found: ScopedBookingRow | null = row()) {
  const repo = {
    byId: vi.fn(() => Promise.resolve(found)),
    byCode: vi.fn(() => Promise.resolve(found)),
  };
  return { s: new BookingScope(repo as never), repo };
}

const lines = (): string[] => warn.mock.calls.map((c) => String(c[0]));

describe('a customer: always checked, flag or not', () => {
  it.each([undefined, 'off', 'log', 'on'])(
    'STAFF_SCOPE_V1=%s',
    async (mode) => {
      if (mode !== undefined) process.env.STAFF_SCOPE_V1 = mode;

      await expect(
        scope().s.refuseOutOfScope(byId, customer(), ROUTE),
      ).resolves.toBeUndefined();
      await expect(
        scope(row({ customerId: STAFF_ID })).s.refuseOutOfScope(
          byId,
          customer(),
          ROUTE,
        ),
      ).rejects.toThrow(new NotFoundException('No such booking'));
      await expect(
        scope(null).s.refuseOutOfScope(byId, customer(), ROUTE),
      ).rejects.toThrow(NotFoundException);
    },
  );

  it('a refused customer is not logged: that rule is not new', async () => {
    await expect(
      scope(row({ customerId: STAFF_ID })).s.refuseOutOfScope(
        byId,
        customer(),
        ROUTE,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('staff, STAFF_SCOPE_V1 off', () => {
  it.each([undefined, 'off', '', 'true', 'onn'])(
    '%j: nothing is looked up, another tenant passes as before',
    async (mode) => {
      if (mode !== undefined) process.env.STAFF_SCOPE_V1 = mode;
      const { s, repo } = scope(row({ tenantId: ROMONI }));

      await expect(
        s.refuseOutOfScope(byId, staff(), ROUTE),
      ).resolves.toBeUndefined();
      expect(repo.byId).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe('staff, STAFF_SCOPE_V1=log: the evidence', () => {
  beforeEach(() => {
    process.env.STAFF_SCOPE_V1 = 'log';
  });

  it('another tenant: logged, and let through', async () => {
    const { s } = scope(row({ tenantId: ROMONI, branchId: BRANCH_B }));

    await expect(
      s.refuseOutOfScope(byId, staff(), ROUTE),
    ).resolves.toBeUndefined();
    expect(lines()).toEqual([
      'WOULD REFUSE (STAFF_SCOPE_V1=log) other_tenant: ' +
        'POST /v1/bookings/:id/cancel ' +
        `actor=staff:${STAFF_ID} ` +
        `token_tenant=${LOOK_CHANGE} token_branch=${BRANCH_A} ` +
        `booking=${BOOKING} code=GS-1234 ` +
        `booking_tenant=${ROMONI} booking_branch=${BRANCH_B}`,
    ]);
  });

  it('a QA token on a marina-walk row shows itself in the line', async () => {
    const marina = toUuid('marina-walk');
    const { s } = scope(row({ tenantId: null, branchId: marina }));

    await s.refuseOutOfScope(
      byId,
      staff({ tenantId: 'qa-run-7', branchId: 'marina-walk' }),
      ROUTE,
    );
    expect(lines()).toEqual([
      'WOULD REFUSE (STAFF_SCOPE_V1=log) untenanted_booking: ' +
        'POST /v1/bookings/:id/cancel ' +
        `actor=staff:${STAFF_ID} ` +
        'token_tenant=qa-run-7 token_branch=marina-walk ' +
        `booking=${BOOKING} code=GS-1234 ` +
        `booking_tenant=none booking_branch=${marina}`,
    ]);
  });

  it('a company owner (no branch) prints token_branch=all', async () => {
    const { s } = scope(row({ tenantId: ROMONI }));
    await s.refuseOutOfScope(
      byId,
      staff({ kind: 'manager', branchId: null }),
      ROUTE,
    );
    expect(lines()[0]).toContain(
      `actor=manager:${STAFF_ID} token_tenant=${LOOK_CHANGE} token_branch=all`,
    );
  });

  it('in scope: nothing logged', async () => {
    await scope().s.refuseOutOfScope(byId, staff(), ROUTE);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('staff, STAFF_SCOPE_V1=on', () => {
  beforeEach(() => {
    process.env.STAFF_SCOPE_V1 = 'on';
  });

  it('its own tenant and branch: through, nothing logged', async () => {
    await expect(
      scope().s.refuseOutOfScope(byId, staff(), ROUTE),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['other_tenant', row({ tenantId: ROMONI })],
    ['other_branch', row({ branchId: BRANCH_B })],
    ['untenanted_booking', row({ tenantId: null })],
  ])(
    '%s: 404 with the missing-booking sentence, and the line says REFUSED',
    async (why, found) => {
      await expect(
        scope(found).s.refuseOutOfScope(byId, staff(), ROUTE),
      ).rejects.toThrow(new NotFoundException('No such booking'));
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(
        new RegExp(`^REFUSED \\(STAFF_SCOPE_V1=on\\) ${why}: ${ROUTE} `),
      );
    },
  );

  it('a booking that is not there: through, for the route to answer', async () => {
    await expect(
      scope(null).s.refuseOutOfScope(byId, staff(), ROUTE),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('no tenant on the token (platform mode): through, nothing logged', async () => {
    await expect(
      scope(row({ tenantId: ROMONI })).s.refuseOutOfScope(
        byId,
        staff({ kind: 'manager', tenantId: null, branchId: null }),
        ROUTE,
      ),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a token branch spelled as a slug is folded as the column is', async () => {
    const marina = toUuid('marina-walk');
    await expect(
      scope(row({ branchId: marina })).s.refuseOutOfScope(
        byId,
        staff({ branchId: 'marina-walk' }),
        ROUTE,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('by code (late-capture): the highest-risk route', () => {
  const LATE = 'POST /v1/bookings/:id/late-capture';

  beforeEach(() => {
    process.env.STAFF_SCOPE_V1 = 'on';
  });

  it('looks the booking up by its code, not by id', async () => {
    const { s, repo } = scope();
    await s.refuseOutOfScope(byCode, staff(), LATE);
    expect(repo.byCode).toHaveBeenCalledWith('GS-1234');
    expect(repo.byId).not.toHaveBeenCalled();
  });

  it("another tenant's code: 404, and the line names the code", async () => {
    const { s } = scope(row({ tenantId: ROMONI }));
    await expect(s.refuseOutOfScope(byCode, staff(), LATE)).rejects.toThrow(
      new NotFoundException('No such booking'),
    );
    expect(lines()[0]).toContain(
      `other_tenant: ${LATE} actor=staff:${STAFF_ID}`,
    );
    expect(lines()[0]).toContain('code=GS-1234');
  });

  it('its own tenant: through', async () => {
    await expect(
      scope().s.refuseOutOfScope(byCode, staff(), LATE),
    ).resolves.toBeUndefined();
  });

  it('a code that matches nothing: through, and late-capture acknowledges it as unknown', async () => {
    await expect(
      scope(null).s.refuseOutOfScope(byCode, staff(), LATE),
    ).resolves.toBeUndefined();
  });
});
