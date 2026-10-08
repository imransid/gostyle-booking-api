import { describe, expect, it } from 'vitest';
import {
  scopeVerdict,
  staffScopeMode,
  type ScopeActor,
  type ScopedBooking,
} from './booking-scope';

const LOOK_CHANGE = 'f2a9882b-c822-4107-b650-29af2e303c24';
const ROMONI = '3c457f1c-e7d4-4c9b-b877-27146c834608';
const BRANCH_A = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';
const BRANCH_B = 'b67fad90-6064-446a-8d80-411347c1f929';
const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';

const booking = (over: Partial<ScopedBooking> = {}): ScopedBooking => ({
  customerId: ME,
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

const staff = (over: Partial<ScopeActor> = {}): ScopeActor => ({
  kind: 'staff',
  id: YOU,
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

const allowed = { kind: 'allowed' };
const refused = (why: string) => ({ kind: 'refused', why });

describe('a customer: their own booking, as before', () => {
  const customer: ScopeActor = {
    kind: 'customer',
    id: ME,
    tenantId: null,
    branchId: null,
  };

  it('their own: allowed', () => {
    expect(scopeVerdict(customer, booking())).toEqual(allowed);
  });

  it("someone else's: refused, whatever the tenant", () => {
    expect(scopeVerdict(customer, booking({ customerId: YOU }))).toEqual(
      refused('not_their_booking'),
    );
  });

  it('a booking with no owner: refused', () => {
    expect(scopeVerdict(customer, booking({ customerId: null }))).toEqual(
      refused('not_their_booking'),
    );
  });
});

describe.each(['staff', 'manager'] as const)('a %s token', (kind) => {
  it('its own tenant and branch: allowed', () => {
    expect(scopeVerdict(staff({ kind }), booking())).toEqual(allowed);
  });

  it("another tenant's booking: refused as other_tenant", () => {
    expect(
      scopeVerdict(staff({ kind }), booking({ tenantId: ROMONI })),
    ).toEqual(refused('other_tenant'));
  });

  it('another tenant, even with no branch on the token', () => {
    expect(
      scopeVerdict(
        staff({ kind, branchId: null }),
        booking({ tenantId: ROMONI, branchId: BRANCH_B }),
      ),
    ).toEqual(refused('other_tenant'));
  });

  it('its own tenant, another branch: refused as other_branch', () => {
    expect(
      scopeVerdict(staff({ kind }), booking({ branchId: BRANCH_B })),
    ).toEqual(refused('other_branch'));
  });

  it('no branch on the token (a company owner): every branch of its tenant', () => {
    expect(
      scopeVerdict(
        staff({ kind, branchId: null }),
        booking({ branchId: BRANCH_B }),
      ),
    ).toEqual(allowed);
  });

  it('a booking with no tenant: refused as untenanted_booking', () => {
    expect(scopeVerdict(staff({ kind }), booking({ tenantId: null }))).toEqual(
      refused('untenanted_booking'),
    );
  });

  it('tenant first: another tenant AND another branch names the tenant', () => {
    expect(
      scopeVerdict(
        staff({ kind }),
        booking({ tenantId: ROMONI, branchId: BRANCH_B }),
      ),
    ).toEqual(refused('other_tenant'));
  });

  it('no tenant on the token (platform mode): anywhere, untenanted included', () => {
    const platform = staff({ kind, tenantId: null, branchId: null });
    expect(scopeVerdict(platform, booking({ tenantId: ROMONI }))).toEqual(
      allowed,
    );
    expect(scopeVerdict(platform, booking({ tenantId: null }))).toEqual(
      allowed,
    );
  });

  it('a blank tenant claim is no tenant claim', () => {
    expect(
      scopeVerdict(
        staff({ kind, tenantId: '  ' }),
        booking({ tenantId: ROMONI }),
      ),
    ).toEqual(allowed);
  });

  it('a spelling is never a refusal: case and stray spaces', () => {
    expect(
      scopeVerdict(
        staff({
          kind,
          tenantId: ` ${LOOK_CHANGE.toUpperCase()} `,
          branchId: BRANCH_A.toUpperCase(),
        }),
        booking(),
      ),
    ).toEqual(allowed);
  });

  it('a customer id is not a pass: owning nothing changes nothing', () => {
    expect(
      scopeVerdict(staff({ kind, id: ME }), booking({ tenantId: ROMONI })),
    ).toEqual(refused('other_tenant'));
  });
});

describe('system', () => {
  it('in-process jobs pass, whatever the booking', () => {
    expect(
      scopeVerdict(
        { kind: 'system', id: '', tenantId: null, branchId: null },
        booking({ tenantId: null }),
      ),
    ).toEqual(allowed);
  });
});

describe('STAFF_SCOPE_V1', () => {
  it.each([
    ['log', 'log'],
    ['on', 'on'],
    [' ON ', 'on'],
    ['Log', 'log'],
    ['off', 'off'],
    [undefined, 'off'],
    ['', 'off'],
    ['true', 'off'],
    ['1', 'off'],
    ['onn', 'off'],
  ])('%j reads as %s', (raw, mode) => {
    expect(staffScopeMode(raw)).toBe(mode);
  });
});
