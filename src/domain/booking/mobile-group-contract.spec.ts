import { describe, expect, it } from 'vitest';
import {
  checkGroupMoney,
  checkParty,
  type GroupClaim,
  type GroupMemberClaim,
  type GroupMoneyClaims,
} from './mobile-group-contract';
import { groupMoney } from './group-money';

const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';

const self: GroupMemberClaim = {
  ref: 0,
  kind: 'self',
  id: BOOKER,
  name: 'Sarah',
  ageGroup: 'adult',
  serviceIds: ['svc-fade'],
  stylistId: 'anna',
};
const registered: GroupMemberClaim = {
  ref: 1,
  kind: 'registered',
  id: RANA,
  name: null,
  ageGroup: 'adult',
  serviceIds: ['svc-fade'],
  stylistId: null,
};
const guest: GroupMemberClaim = {
  ref: 2,
  kind: 'guest',
  id: null,
  name: 'Liam (8 yrs)',
  ageGroup: 'child',
  serviceIds: ['svc-kids'],
  stylistId: 'ava',
};

const party = (
  members: GroupMemberClaim[] = [self, registered, guest],
  over: Partial<GroupClaim> = {},
): GroupClaim => ({
  members,
  status: 'BOOKED',
  paymentStatus: 'DRAFT',
  bookingType: 'GROUP',
  ...over,
});

const codeOf = (claim: GroupClaim, booker = BOOKER): string | null =>
  checkParty(claim, booker)?.code ?? null;

describe('checkParty: a good party', () => {
  it('passes', () => {
    expect(checkParty(party(), BOOKER)).toBeNull();
  });

  it('matches the booker whatever case the id is in', () => {
    expect(codeOf(party(), BOOKER.toUpperCase())).toBeNull();
  });
});

describe('checkParty: the create words (§4)', () => {
  it('only GROUP', () => {
    expect(codeOf(party(undefined, { bookingType: 'SINGLE' }))).toBe(
      'invalid_booking_type',
    );
  });
  it('only BOOKED', () => {
    expect(codeOf(party(undefined, { status: 'CONFIRMED' }))).toBe(
      'invalid_status',
    );
  });
  it('only DRAFT: a party has no pay-at-the-salon arrangement', () => {
    expect(
      codeOf(party(undefined, { paymentStatus: 'PAY_AFTER_CHECK_IN' })),
    ).toBe('invalid_payment_status');
  });
});

describe('checkParty: §7', () => {
  it('fewer than 2 is invalid_party_size', () => {
    expect(codeOf(party([self]))).toBe('invalid_party_size');
  });

  it('more than 8 is invalid_party_size', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...guest,
      ref: i + 10,
    }));
    expect(codeOf(party([self, ...many]))).toBe('invalid_party_size');
  });

  it('8 is fine', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      ...guest,
      ref: i + 10,
      stylistId: null,
    }));
    expect(codeOf(party([self, ...seven]))).toBeNull();
  });

  it('two members with one ref is duplicate_ref', () => {
    expect(codeOf(party([self, { ...registered, ref: 0 }]))).toBe(
      'duplicate_ref',
    );
  });

  it('a member with no services is member_no_services', () => {
    expect(codeOf(party([self, { ...registered, serviceIds: [] }]))).toBe(
      'member_no_services',
    );
  });

  it('no self is invalid_member_kind', () => {
    expect(codeOf(party([registered, guest]))).toBe('invalid_member_kind');
  });

  it('two selves is invalid_member_kind', () => {
    expect(codeOf(party([self, { ...self, ref: 5 }]))).toBe(
      'invalid_member_kind',
    );
  });

  it('a self who is not the token is invalid_member_kind', () => {
    expect(codeOf(party(), RANA)).toBe('invalid_member_kind');
  });

  it('an unknown kind is invalid_member_kind', () => {
    expect(codeOf(party([self, { ...registered, kind: 'friend' }]))).toBe(
      'invalid_member_kind',
    );
  });

  it('one account twice is invalid_member_kind', () => {
    expect(codeOf(party([self, { ...registered, id: BOOKER }]))).toBe(
      'invalid_member_kind',
    );
  });

  it('a registered member without an id is member_id_required', () => {
    expect(codeOf(party([self, { ...registered, id: null }]))).toBe(
      'member_id_required',
    );
  });

  it('a self without an id is member_id_required', () => {
    expect(codeOf(party([{ ...self, id: ' ' }, registered]))).toBe(
      'member_id_required',
    );
  });

  it('a guest without a name is member_name_required', () => {
    expect(codeOf(party([self, { ...guest, name: '  ' }]))).toBe(
      'member_name_required',
    );
  });

  it('a guest carrying an account id is refused, never filed under it', () => {
    expect(codeOf(party([self, { ...guest, id: RANA }]))).toBe(
      'invalid_member_kind',
    );
  });

  it('an age group other than adult or child is invalid_age_group', () => {
    expect(codeOf(party([self, { ...guest, ageGroup: 'teen' }]))).toBe(
      'invalid_age_group',
    );
  });

  it('one stylist chosen for two members is stylist_repeated', () => {
    expect(codeOf(party([self, { ...guest, stylistId: 'ANNA' }]))).toBe(
      'stylist_repeated',
    );
  });

  it('says which member is wrong', () => {
    const r = checkParty(
      party([self, { ...registered, serviceIds: [] }]),
      BOOKER,
    );
    expect(r?.field).toBe('members[1].services');
  });
});

describe('checkGroupMoney', () => {
  // 250 + 250 adults, a 240 child service halved to 120: 620 net.
  const expected = groupMoney(
    [
      { ageGroup: 'adult', serviceFils: [25_000], products: [] },
      { ageGroup: 'adult', serviceFils: [25_000], products: [] },
      { ageGroup: 'child', serviceFils: [24_000], products: [] },
    ],
    20,
  );
  const good: GroupMoneyClaims = {
    amountWithoutTax: 620,
    taxAmount: 31,
    discount: 0,
    total: 651,
    advancePaidAmount: 0,
    dueAmount: 651,
    depositPercent: 20,
  };

  it('passes figures that agree', () => {
    expect(checkGroupMoney(good, expected)).toBeNull();
  });

  it('passes a missing deposit_percent: the server holds it', () => {
    expect(
      checkGroupMoney({ ...good, depositPercent: null }, expected),
    ).toBeNull();
  });

  it('refuses another deposit percent, naming the right one (D1)', () => {
    expect(checkGroupMoney({ ...good, depositPercent: 10 }, expected)).toEqual({
      field: 'deposit_percent',
      code: 'amount_mismatch',
      message: 'The deposit for a group is 20%.',
      expected: 20,
    });
  });

  it('refuses a total that ignores the child price, carrying the right one', () => {
    const r = checkGroupMoney(
      {
        ...good,
        amountWithoutTax: 740,
        taxAmount: 37,
        total: 777,
        dueAmount: 777,
      },
      expected,
    );
    expect(r).toMatchObject({
      field: 'amount_without_tax',
      code: 'amount_mismatch',
      expected: 620,
    });
  });

  it('allows one fil either way, as the single booking does', () => {
    expect(
      checkGroupMoney({ ...good, total: 651.01, dueAmount: 651.01 }, expected),
    ).toBeNull();
    expect(checkGroupMoney({ ...good, total: 651.02 }, expected)?.field).toBe(
      'total',
    );
  });

  it('refuses a discount: a party has none (D2)', () => {
    expect(checkGroupMoney({ ...good, discount: 5 }, expected)?.field).toBe(
      'discount',
    );
  });

  it('refuses money paid on create', () => {
    expect(
      checkGroupMoney({ ...good, advancePaidAmount: 10 }, expected),
    ).toMatchObject({ field: 'advance_paid_amount', expected: 0 });
  });

  it('refuses a due amount that is not the total', () => {
    expect(
      checkGroupMoney({ ...good, dueAmount: 500 }, expected),
    ).toMatchObject({
      field: 'due_amount',
      expected: 651,
    });
  });

  it('refuses a third decimal place', () => {
    expect(
      checkGroupMoney({ ...good, taxAmount: 31.001 }, expected)?.field,
    ).toBe('tax_amount');
  });
});
