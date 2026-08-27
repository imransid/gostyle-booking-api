import type { Tier } from './customer';

/**
 * The waitlist is what turns a cancellation into revenue rather than a hole
 * in the day.
 *
 * Every path that frees a slot (cancel, no-show, auto no-show, reschedule,
 * group exit, expiry) calls the same offer function. One entry point means
 * one set of rules, and a new way of freeing a slot inherits them for free.
 */

export interface WaitlistEntry {
  readonly id: string;
  readonly customerId: string;
  readonly serviceId: string;
  readonly tradingDay: string;
  /** The span they said they were free. */
  readonly windowFromMin: number;
  readonly windowToMin: number;
  /** null means "any professional". */
  readonly preferredStaffId: string | null;
  readonly tier: Tier;
  readonly joinedAtMs: number;
  readonly declineCount: number;
  /** Booking codes this entry has already turned down. */
  readonly declinedCodes: readonly string[];
}

/** A slot that has just come back into circulation. */
export interface FreedSlot {
  readonly bookingCode: string;
  /** The FIRST service of the freed booking. */
  readonly serviceId: string;
  readonly tradingDay: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly staffId: string;
}

/**
 * A candidate who declines this many offers leaves the list for this window.
 *
 * Without the cap, one customer holding out for a specific hour absorbs every
 * offer and blocks the people who would have taken them. The message says
 * offers will stop and that they may rejoin at any time, so it reads as a
 * pause rather than a punishment.
 */
export const DECLINE_CAP = 3;

/** How long the top candidate has before the offer passes down. */
export const OFFER_TTL_MS = 15 * 60 * 1000;

export type MatchFailure =
  | 'different_service'
  | 'different_day'
  | 'outside_window'
  | 'different_professional'
  | 'already_declined'
  | 'decline_cap_reached';

export type MatchVerdict =
  | { readonly kind: 'match' }
  | { readonly kind: 'no_match'; readonly why: MatchFailure };

/**
 * Does this entry want this slot?
 *
 * Five conditions, ALL of which must hold. Returning the reason rather than a
 * bare false is what lets an operator answer "why wasn't I offered that?"
 * without anyone re-deriving the rules by hand.
 */
export function matches(entry: WaitlistEntry, slot: FreedSlot): MatchVerdict {
  if (entry.declineCount >= DECLINE_CAP) {
    return { kind: 'no_match', why: 'decline_cap_reached' };
  }
  if (entry.serviceId !== slot.serviceId) {
    return { kind: 'no_match', why: 'different_service' };
  }
  if (entry.tradingDay !== slot.tradingDay) {
    return { kind: 'no_match', why: 'different_day' };
  }
  // The START must fall inside the window. A visit that runs past the end of
  // it is fine: the window says when they can ARRIVE, not when they must be
  // finished, and a customer free from 14:00 does not mean free until 14:45.
  if (
    slot.startMin < entry.windowFromMin ||
    slot.startMin >= entry.windowToMin
  ) {
    return { kind: 'no_match', why: 'outside_window' };
  }
  if (
    entry.preferredStaffId !== null &&
    entry.preferredStaffId !== slot.staffId
  ) {
    return { kind: 'no_match', why: 'different_professional' };
  }
  // A slot they have already turned down is not offered twice, even if it
  // frees up again later.
  if (entry.declinedCodes.includes(slot.bookingCode)) {
    return { kind: 'no_match', why: 'already_declined' };
  }
  return { kind: 'match' };
}

/** Royal and VIP, then Gold, then Silver, then none. */
const TIER_RANK: Record<Tier, number> = {
  royal: 0,
  vip: 0,
  gold: 1,
  silver: 2,
  none: 3,
};

/**
 * How much room the window has beyond the service. Smaller is a better fit.
 *
 * A customer free from 14:00 to 15:00 for a 45-minute cut has 15 minutes of
 * slack; one free all afternoon has hours. The tight fit wins, because this
 * slot is nearly perfect for them and merely convenient for the other.
 */
export function slackMin(entry: WaitlistEntry, slot: FreedSlot): number {
  return entry.windowToMin - entry.windowFromMin - slot.durationMin;
}

/**
 * The queue, in the order offers go out.
 *
 * NOTE ON KEYS 2 AND 3. The specification ranks by join order first, with
 * tier and fit as tie-breaks "when join order ties". Join times are
 * millisecond timestamps, so they never tie, and as written tier and fit can
 * never fire.
 *
 * Implemented exactly as specified rather than quietly improved, because
 * changing who gets offered a slot is a business decision, not a coding one.
 * If tier is meant to carry weight, join order needs bucketing (by day, say)
 * and that is a conversation to have rather than a default to invent.
 */
export function rank(
  entries: readonly WaitlistEntry[],
  slot: FreedSlot,
): WaitlistEntry[] {
  return entries
    .filter((e) => matches(e, slot).kind === 'match')
    .sort(
      (a, b) =>
        a.joinedAtMs - b.joinedAtMs ||
        TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
        slackMin(a, slot) - slackMin(b, slot) ||
        (a.id < b.id ? -1 : 1),
    );
}

export interface OfferPlan {
  readonly candidates: readonly WaitlistEntry[];
  readonly offerTo: WaitlistEntry | null;
  readonly expiresAtMs: number | null;
  /** Why each entry that wanted this day missed out. For the operator. */
  readonly passedOver: readonly {
    readonly id: string;
    readonly why: MatchFailure;
  }[];
}

/** Who gets the offer, who does not, and why. */
export function planOffer(
  entries: readonly WaitlistEntry[],
  slot: FreedSlot,
  nowMs: number,
): OfferPlan {
  const candidates = rank(entries, slot);
  const passedOver = entries
    .map((e) => ({ id: e.id, verdict: matches(e, slot) }))
    .filter((x) => x.verdict.kind === 'no_match')
    .map((x) => ({ id: x.id, why: (x.verdict as { why: MatchFailure }).why }));

  const top = candidates[0] ?? null;
  return {
    candidates,
    offerTo: top,
    expiresAtMs: top === null ? null : nowMs + OFFER_TTL_MS,
    passedOver,
  };
}

export type DeclineOutcome =
  | { readonly kind: 'passes_down'; readonly declineCount: number }
  | {
      readonly kind: 'leaves_list';
      readonly declineCount: number;
      readonly message: string;
    };

/** A decline, and whether it was their last. */
export function decline(entry: WaitlistEntry): DeclineOutcome {
  const declineCount = entry.declineCount + 1;
  if (declineCount >= DECLINE_CAP) {
    return {
      kind: 'leaves_list',
      declineCount,
      message:
        'Offers will stop for this window. You can rejoin the waitlist at any time.',
    };
  }
  return { kind: 'passes_down', declineCount };
}
