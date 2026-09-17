/**
 * The vocabulary the seven booking screens speak.
 *
 * `wire.ts` shouts our own words so the front end can render them. This file
 * is the other half of the problem: where THEIR enum has fewer members than
 * ours, something has to decide which of our words maps onto which of theirs,
 * and that decision belongs in one place rather than in six query handlers.
 *
 * TWO PROJECTIONS, both lossy in the same deliberate direction.
 *
 * STATUS. We model fourteen states; the screens model ten. The four extras
 * are `draft` and `held` (pre-creation: a row in either state has no business
 * on a diary), and `rescheduled` and `skipped` (real outcomes with no tile of
 * their own). Rather than invent a tile, `rescheduled` reports as CANCELLED
 * and `skipped` as EXPIRED -- in both cases the slot was given up and the
 * money outcome already says which -- and the UNPROJECTED word travels
 * alongside as `statusDetail`, so nothing is actually hidden.
 *
 * PAYMENT. We model eight payment states; the screens model four. Everything
 * after settlement (`partially_refunded`, `refunded`, `forfeited`, `settled`)
 * is reported as PAID, because from the diary's point of view the money was
 * taken; what happened to it afterwards is the ledger's story, and the ledger
 * travels on the same payload.
 */

import type { BookingStatus } from '@domain/booking/lifecycle';
import type { PaymentStatus } from '../../generated/prisma/enums';

/** The ten the screens render. */
export type ScreenStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_CONFIRM'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_SERVICE'
  | 'COMPLETED'
  | 'SETTLED'
  | 'NO_SHOW'
  | 'CANCELLED'
  | 'EXPIRED';

const STATUS_MAP: Readonly<Record<BookingStatus, ScreenStatus>> = {
  // Pre-creation. Neither ever reaches a diary read, but a total map is
  // better than a partial one plus a throw at 3am.
  draft: 'PENDING_CONFIRM',
  held: 'PENDING_CONFIRM',

  pending_payment: 'PENDING_PAYMENT',
  pending_confirmation: 'PENDING_CONFIRM',
  confirmed: 'CONFIRMED',
  checked_in: 'CHECKED_IN',
  in_service: 'IN_SERVICE',
  completed: 'COMPLETED',
  settled: 'SETTLED',
  cancelled: 'CANCELLED',
  no_show: 'NO_SHOW',
  expired: 'EXPIRED',

  // The two with no tile of their own. See the header.
  rescheduled: 'CANCELLED',
  skipped: 'EXPIRED',
};

export function toScreenStatus(status: BookingStatus): ScreenStatus {
  return STATUS_MAP[status];
}

/**
 * Is this screen word ambiguous -- does more than one of our statuses land on
 * it?
 *
 * DERIVED, NOT LISTED. A hand-written list of "the lossy ones" is a second
 * copy of STATUS_MAP and would go stale the first time somebody remapped a
 * status without updating it (CLAUDE.md 4). Counting the map cannot.
 *
 * Three words are ambiguous today: PENDING_CONFIRM (draft, held,
 * pending_confirmation), CANCELLED (cancelled, rescheduled) and EXPIRED
 * (expired, skipped).
 *
 * Callers do not actually branch on this -- `statusDetail` carries our own
 * word on EVERY row, because a field that is present only sometimes is a
 * field the client forgets to read. It is exported so the ambiguity is
 * assertable in a test rather than discovered on a screen.
 */
export function isAmbiguous(status: BookingStatus): boolean {
  const screen = STATUS_MAP[status];
  return Object.values(STATUS_MAP).filter((v) => v === screen).length > 1;
}

/** The four the screens render. */
export type ScreenPaymentState = 'NONE' | 'PENDING' | 'PAID' | 'FULL';

const PAYMENT_MAP: Readonly<Record<PaymentStatus, ScreenPaymentState>> = {
  none_required: 'NONE',
  unpaid: 'PENDING',
  deposit_paid: 'PAID',
  fully_paid: 'FULL',

  // After the fact. Money WAS taken; the ledger says what became of it.
  partially_refunded: 'PAID',
  refunded: 'PAID',
  forfeited: 'PAID',
  settled: 'PAID',
};

export function toScreenPayment(status: PaymentStatus): ScreenPaymentState {
  return PAYMENT_MAP[status];
}

/** `payment.depositOutcome`, where one applies. */
export type DepositOutcome = 'KEPT' | 'FORFEITED' | 'REFUNDED' | 'GOODWILL';

const OUTCOME_MAP: Readonly<Partial<Record<PaymentStatus, DepositOutcome>>> = {
  forfeited: 'FORFEITED',
  refunded: 'REFUNDED',
  partially_refunded: 'REFUNDED',
  settled: 'KEPT',
};

export function toDepositOutcome(status: PaymentStatus): DepositOutcome | null {
  return OUTCOME_MAP[status] ?? null;
}

/**
 * The filter chips on the upcoming list.
 *
 * A closed set, because each one is a different WHERE clause and a free-text
 * filter would be a place to typo a status.
 */
export const LIST_FILTERS = [
  'ALL',
  'TODAY',
  'TOMORROW',
  'DEPOSIT_PENDING',
  'CONFLICTS',
  'UNCONFIRMED',
  'NOT_REMINDED',
] as const;

export type ListFilter = (typeof LIST_FILTERS)[number];

export function isListFilter(v: string): v is ListFilter {
  return (LIST_FILTERS as readonly string[]).includes(v);
}

/**
 * Which of our statuses each chip means.
 *
 * `null` means the chip is not a status filter at all -- TODAY and TOMORROW
 * are date windows, CONFLICTS is a join against the worklist -- and the
 * caller applies its own clause. Returning null rather than every status
 * keeps "no status filter" and "all statuses" from looking identical.
 */
export function statusesFor(
  filter: ListFilter,
): readonly BookingStatus[] | null {
  switch (filter) {
    case 'DEPOSIT_PENDING':
      return ['pending_payment'];
    case 'UNCONFIRMED':
      return ['pending_confirmation', 'pending_payment'];
    case 'ALL':
    case 'TODAY':
    case 'TOMORROW':
    case 'NOT_REMINDED':
    case 'CONFLICTS':
      return null;
  }
}

/**
 * The statuses a diary read shows by default.
 *
 * Shared by every list and calendar read so the upcoming list and the day
 * grid cannot disagree about whether a cancelled visit is visible.
 */
export const LIVE_STATUSES: readonly BookingStatus[] = [
  'pending_payment',
  'pending_confirmation',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
];
