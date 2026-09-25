import { aedToFils, amountsAgree, filsToAed } from './mobile-contract';
import type { AgeGroup, GroupMoney } from './group-money';

/**
 * The rules a mobile group booking request must meet before anything is
 * looked up or held (docs/APP_GROUP_BOOKING_SPEC.md §4, §7).
 *
 * PURE: no ids are resolved here. Whether a service is sold at the salon or
 * an account exists is answered further in, by the catalogue and by
 * gostyle-customer-api. This only says whether the request makes sense on
 * its own, and says it in the app's words.
 *
 * gostyle-customer-api checks the same things first and in the same words,
 * so the app normally hears them from there. These still run: this service
 * does not trust a body because it came from a neighbour.
 */

export const MIN_PARTY = 2;
export const MAX_PARTY = 8;

export type MemberKind = 'self' | 'registered' | 'guest';

const KINDS: readonly string[] = ['self', 'registered', 'guest'];
const AGE_GROUPS: readonly string[] = ['adult', 'child'];

export type GroupRefusalCode =
  | 'invalid_party_size'
  | 'duplicate_ref'
  | 'member_no_services'
  | 'invalid_member_kind'
  | 'member_id_required'
  | 'member_name_required'
  | 'invalid_age_group'
  | 'invalid_booking_type'
  | 'invalid_status'
  | 'invalid_payment_status'
  | 'stylist_repeated'
  | 'amount_mismatch';

export interface GroupRefusal {
  readonly field: string;
  readonly code: GroupRefusalCode;
  readonly message: string;
  readonly expected?: number;
}

export interface GroupMemberClaim {
  readonly ref: number;
  readonly kind: string;
  /** The account id. Required for `self` and `registered`, absent for `guest`. */
  readonly id: string | null;
  readonly name: string | null;
  readonly ageGroup: string;
  readonly serviceIds: readonly string[];
  readonly stylistId: string | null;
}

export interface GroupClaim {
  readonly members: readonly GroupMemberClaim[];
  readonly status: string;
  readonly paymentStatus: string;
  readonly bookingType: string;
}

/** A member the request passed, with its words narrowed. */
export interface CheckedMember extends GroupMemberClaim {
  readonly kind: MemberKind;
  readonly ageGroup: AgeGroup;
}

function sameId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function refuse(
  field: string,
  code: GroupRefusalCode,
  message: string,
): GroupRefusal {
  return { field, code, message };
}

/**
 * The first thing wrong with the party, or null.
 *
 * `bookerId` is the token's own account. The one `self` member must be it:
 * the booker is never taken from the payload (§4, §7).
 */
export function checkParty(
  claim: GroupClaim,
  bookerId: string,
): GroupRefusal | null {
  if (claim.bookingType !== 'GROUP') {
    return refuse(
      'booking_type',
      'invalid_booking_type',
      'Only GROUP may be sent here.',
    );
  }
  if (claim.status !== 'BOOKED') {
    return refuse(
      'status',
      'invalid_status',
      'Only BOOKED may be sent on create.',
    );
  }
  if (claim.paymentStatus !== 'DRAFT') {
    // A party is always paid in the app after it is created (§4): there is
    // no pay-at-the-salon arrangement for a group.
    return refuse(
      'payment_status',
      'invalid_payment_status',
      'Only DRAFT may be sent on create. Record the payment with PATCH once the gateway answers.',
    );
  }

  const members = claim.members;
  if (members.length < MIN_PARTY || members.length > MAX_PARTY) {
    return refuse(
      'members',
      'invalid_party_size',
      `A group booking is for ${MIN_PARTY} to ${MAX_PARTY} people.`,
    );
  }

  const refs = members.map((m) => m.ref);
  if (new Set(refs).size !== refs.length) {
    return refuse(
      'members',
      'duplicate_ref',
      'Every member needs its own ref.',
    );
  }

  for (const [i, m] of members.entries()) {
    const at = `members[${i}]`;
    if (!KINDS.includes(m.kind)) {
      return refuse(
        `${at}.kind`,
        'invalid_member_kind',
        'kind must be self, registered or guest.',
      );
    }
    if (!AGE_GROUPS.includes(m.ageGroup)) {
      return refuse(
        `${at}.age_group`,
        'invalid_age_group',
        'age_group must be adult or child.',
      );
    }
    if (m.serviceIds.length === 0) {
      return refuse(
        `${at}.services`,
        'member_no_services',
        'Pick at least one service for every member.',
      );
    }
    if (m.kind === 'guest') {
      if (m.id !== null) {
        // An id riding along on a guest would file their booking under
        // whoever the id belongs to.
        return refuse(
          `${at}.id`,
          'invalid_member_kind',
          'A guest has no account. Send a registered member for an account.',
        );
      }
      if ((m.name ?? '').trim() === '') {
        return refuse(
          `${at}.name`,
          'member_name_required',
          'A guest needs a name.',
        );
      }
    } else if (m.id === null || m.id.trim() === '') {
      return refuse(
        `${at}.id`,
        'member_id_required',
        'This member needs the id of their account.',
      );
    }
  }

  const selves = members.filter((m) => m.kind === 'self');
  if (selves.length !== 1) {
    return refuse(
      'members',
      'invalid_member_kind',
      'Exactly one member must be you (kind: self).',
    );
  }
  if (!sameId(selves[0]!.id!, bookerId)) {
    return refuse(
      'members',
      'invalid_member_kind',
      'The member marked self must be the signed-in account.',
    );
  }

  const accounts = members
    .filter((m) => m.id !== null)
    .map((m) => m.id!.trim().toLowerCase());
  if (new Set(accounts).size !== accounts.length) {
    return refuse(
      'members',
      'invalid_member_kind',
      'Each account can be in the party only once.',
    );
  }

  const chosen = members
    .map((m) => m.stylistId)
    .filter((s): s is string => s !== null)
    .map((s) => s.trim().toLowerCase());
  if (new Set(chosen).size !== chosen.length) {
    // Everyone starts together and each member needs their own stylist, so
    // one stylist chosen twice fits at no time at all.
    return refuse(
      'members',
      'stylist_repeated',
      'Everyone in the party needs their own stylist. Choose a different one, or let the salon assign one.',
    );
  }

  return null;
}

/** The figures the app displayed, as it sent them (decimal AED). */
export interface GroupMoneyClaims {
  readonly amountWithoutTax: number;
  readonly taxAmount: number;
  readonly discount: number;
  readonly total: number;
  readonly advancePaidAmount: number;
  readonly dueAmount: number;
  /** Omitted means "whatever the server holds". */
  readonly depositPercent: number | null;
}

/**
 * The app's figures against the server's, figure by figure (§5).
 *
 * Reported as a field error carrying the right number, as the single booking
 * does: the app's job on a mismatch is to show what changed.
 */
export function checkGroupMoney(
  claims: GroupMoneyClaims,
  expected: GroupMoney,
): GroupRefusal | null {
  if (
    claims.depositPercent !== null &&
    claims.depositPercent !== expected.depositPercent
  ) {
    // D1: the server decides the deposit. The app's percent must be the
    // one the server holds, or the app is showing a deposit nobody takes.
    return {
      field: 'deposit_percent',
      code: 'amount_mismatch',
      message: `The deposit for a group is ${expected.depositPercent}%.`,
      expected: expected.depositPercent,
    };
  }

  const checks: readonly [string, number, number][] = [
    ['amount_without_tax', claims.amountWithoutTax, expected.netFils],
    ['tax_amount', claims.taxAmount, expected.vatFils],
    ['discount', claims.discount, expected.discountFils],
    ['total', claims.total, expected.totalFils],
    ['due_amount', claims.dueAmount, expected.totalFils],
  ];
  for (const [field, claimed, want] of checks) {
    const fils = aedToFils(claimed);
    if (fils === null || !amountsAgree(want, fils)) {
      return {
        field,
        code: 'amount_mismatch',
        message:
          field === 'due_amount'
            ? 'due_amount is total minus advance_paid_amount, so it equals total on create.'
            : 'Prices changed since this booking was started.',
        expected: filsToAed(want),
      };
    }
  }

  if (aedToFils(claims.advancePaidAmount) !== 0) {
    return {
      field: 'advance_paid_amount',
      code: 'amount_mismatch',
      message:
        'Nothing is paid on create; record the payment with PATCH once the gateway answers.',
      expected: 0,
    };
  }

  return null;
}
