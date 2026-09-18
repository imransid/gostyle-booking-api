/**
 * The mobile app's vocabulary, and the edge where it meets ours.
 *
 * `docs/booking-create.md` was written against a different model of a
 * booking. Three of its words do not exist as enum values here, money is
 * decimal on its wire and whole fils in our columns, and it sends a time as
 * an ISO instant where the engine works in minutes past branch midnight.
 *
 * ALL OF THAT IS TRANSLATED HERE, in one file with a spec, rather than at
 * the six call sites that would otherwise each do a bit of it. The rule is
 * the same one `wire.ts` follows: the engine never learns a second dialect,
 * and the dialect never leaks inward.
 */

import { Money } from '../shared/money';
import type { BookingStatus } from './lifecycle';
import type { PaymentStatus } from '../../generated/prisma/enums';

// ------------------------------------------------------------ status words

/**
 * The app sends and receives `BOOKED`. We store two states that both mean it.
 *
 * `BOOKED` is the only status the contract accepts on create (§4), and it
 * covers both `pending_confirmation` (waiting on the customer) and
 * `pending_payment` (waiting on money). Collapsing them outbound is lossy,
 * so `statusDetail` carries our own word alongside -- the same arrangement
 * the desk payload already uses for its three ambiguous words.
 */
export type MobileStatus =
  'BOOKED' | 'CONFIRMED_BY_SALON' | 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED';

const STATUS_TO_MOBILE: Readonly<Record<BookingStatus, MobileStatus>> = {
  draft: 'BOOKED',
  held: 'BOOKED',
  pending_payment: 'BOOKED',
  pending_confirmation: 'BOOKED',
  confirmed: 'CONFIRMED_BY_SALON',
  checked_in: 'CHECKED_IN',
  in_service: 'CHECKED_IN',
  completed: 'COMPLETED',
  settled: 'COMPLETED',
  cancelled: 'CANCELLED',
  no_show: 'CANCELLED',
  rescheduled: 'CANCELLED',
  expired: 'CANCELLED',
  skipped: 'CANCELLED',
};

export function toMobileStatus(status: BookingStatus): MobileStatus {
  return STATUS_TO_MOBILE[status];
}

/**
 * `DRAFT` is the app's word for "created, nothing settled".
 *
 * Our `unpaid` is the same state. `PARTIALLY` is `deposit_paid` and
 * `FULLY_PAID` is `fully_paid`; the contract has no word at all for what
 * happens after a refund or a forfeit, so those report as the payment state
 * they came from rather than inventing one the app cannot render.
 */
export type MobilePaymentStatus =
  'DRAFT' | 'PARTIALLY' | 'FULLY_PAID' | 'PAY_AFTER_CHECK_IN';

const PAYMENT_TO_MOBILE: Readonly<Record<PaymentStatus, MobilePaymentStatus>> =
  {
    unpaid: 'DRAFT',
    none_required: 'PAY_AFTER_CHECK_IN',
    deposit_paid: 'PARTIALLY',
    fully_paid: 'FULLY_PAID',
    // After the fact. Money WAS taken; which way it went afterwards is the
    // ledger's story and the app has no word for it.
    partially_refunded: 'PARTIALLY',
    refunded: 'PARTIALLY',
    forfeited: 'PARTIALLY',
    settled: 'FULLY_PAID',
  };

export function toMobilePaymentStatus(
  status: PaymentStatus,
): MobilePaymentStatus {
  return PAYMENT_TO_MOBILE[status];
}

// ------------------------------------------------------------ money

/**
 * The app speaks decimal AED; the columns are whole fils (CLAUDE.md 2).
 *
 * A VALUE WITH MORE THAN TWO DECIMALS IS REFUSED, not rounded. §2 says "at
 * most two decimal places", and silently rounding 12.005 to 12.01 would make
 * the server agree with a figure the customer was never shown -- which is
 * the exact failure §3's verification exists to catch.
 */
export function aedToFils(amount: number): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const fils = Math.round(amount * 100);
  // Guard against a third decimal, allowing for float representation.
  if (Math.abs(amount * 100 - fils) > 1e-6) return null;
  return fils;
}

/** Fils back to the decimal the app expects. Two places, always. */
export function filsToAed(fils: number): number {
  return Number((Money.fils(fils).fils / 100).toFixed(2));
}

/**
 * §3's comparison: equal within one minor unit.
 *
 * The tolerance is not politeness. The client and the server round at
 * different points in the same arithmetic -- the client per line, the server
 * once at the end -- so a correct client can legitimately land a fil away on
 * a basket with a percentage discount. Two fils apart is a different
 * calculation, and that is what this refuses.
 */
export const AMOUNT_TOLERANCE_FILS = 1;

export function amountsAgree(
  expectedFils: number,
  claimedFils: number,
): boolean {
  return Math.abs(expectedFils - claimedFils) <= AMOUNT_TOLERANCE_FILS;
}

// ------------------------------------------------------------ time

export interface BranchMoment {
  /** YYYY-MM-DD, branch-local. */
  readonly tradingDay: string;
  /** Minutes past branch-local midnight. */
  readonly minuteOfDay: number;
}

/**
 * An ISO instant with an offset, as the branch's own wall clock.
 *
 * WHY NOT READ THE STRING'S OWN OFFSET. `2026-09-20T20:00:00+04:00` and
 * `2026-09-20T16:00:00Z` are the same instant, and the app may send either.
 * Trusting the written offset makes the second one land at 16:00 on the
 * diary. Converting to an instant and then into the BRANCH's offset gives
 * the same answer for both, which is the only version that cannot be fooled
 * by a client in another timezone.
 */
export function toBranchMoment(
  iso: string,
  branchOffsetMin: number,
): BranchMoment | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const shifted = new Date(ms + branchOffsetMin * 60_000);
  return {
    tradingDay: shifted.toISOString().slice(0, 10),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * An instant, written with the branch's own offset.
 *
 * §8 returns `2026-09-20T20:00:00+04:00`, not the same instant as `Z`. Both
 * are valid ISO 8601 and both parse to the same moment -- but an app that
 * slices the first sixteen characters to show "20:00" reads `16:00` off the
 * Z form, and that is a plausible thing for a client to do with a field the
 * contract always shows in local time. Matching the contract exactly costs
 * nothing and removes the question.
 */
export function toOffsetIso(instant: Date, branchOffsetMin: number): string {
  const shifted = new Date(instant.getTime() + branchOffsetMin * 60_000);
  const sign = branchOffsetMin < 0 ? '-' : '+';
  const abs = Math.abs(branchOffsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/**
 * §12.1: `date` and `start_time` are both sent, so both must agree.
 *
 * Rejected rather than guessed. Whichever one the server picked, it would be
 * right half the time and wrong silently the other half.
 */
export function dateAgreesWithStart(
  date: string,
  start: BranchMoment,
): boolean {
  return date === start.tradingDay;
}

// ------------------------------------------------------------ refusals

/**
 * The parts of the contract this service cannot honour.
 *
 * REFUSED, NOT PARTIALLY SUPPORTED. Each of these needs data that does not
 * exist yet, and the half-version of every one of them is worse than a clear
 * refusal: a product silently dropped from a basket is money not taken, a
 * ROUTINE booking that creates one visit is a customer expecting twelve, and
 * "the salon assigns someone" that picks the first free body puts an
 * unqualified stylist on a colour.
 */
export type Unsupported =
  'products_not_supported' | 'routine_not_supported' | 'stylist_required';

export interface UnsupportedRefusal {
  readonly code: Unsupported;
  readonly field: string;
  readonly message: string;
}

export function refuseUnsupported(input: {
  readonly products: readonly unknown[] | undefined;
  readonly bookingType: string;
  readonly stylists: readonly string[];
}): UnsupportedRefusal | null {
  if (input.products !== undefined && input.products.length > 0) {
    return {
      code: 'products_not_supported',
      field: 'products',
      message:
        'Products cannot be sold with a booking yet: there is no product ' +
        'catalogue to price against, so the line could not be verified.',
    };
  }

  if (input.bookingType === 'ROUTINE') {
    return {
      code: 'routine_not_supported',
      field: 'booking_type',
      message:
        'A recurring booking needs a recurrence rule, and this payload ' +
        'carries none. Use the series endpoints, which take a pattern.',
    };
  }

  if (input.stylists.length === 0) {
    return {
      code: 'stylist_required',
      field: 'stylists',
      message:
        'Name a stylist. The salon cannot assign a qualified one here ' +
        'because the staff directory does not publish skills, and picking ' +
        'whoever is free could put an unqualified stylist on the service.',
    };
  }

  return null;
}

/**
 * §5: several stylists means one per service, positionally.
 *
 * One stylist covers the whole visit; more than one must line up with the
 * services exactly. Anything between is the ambiguity §12.2 is about, and it
 * is refused rather than interpreted.
 */
export function stylistsLineUp(
  stylists: readonly string[],
  services: readonly unknown[],
): boolean {
  return stylists.length === 1 || stylists.length === services.length;
}
