/**
 * A hold is what turns an advisory offer into something the desk can safely
 * spend two minutes paying for.
 *
 * Two ideas carry it, and both are pure:
 *
 *   1. a FEASIBILITY TOKEN, so a world that changed underneath us is detected
 *      rather than assumed away
 *   2. a TTL, so capacity a customer walked away from returns to circulation
 *
 * Neither knows about the database. The reservation rows are the shell's job.
 */

// ---------------------------------------------------------------- the token

/**
 * One booking as the search actually saw it.
 *
 * Only the four fields that can invalidate a slot. The customer's name can
 * change all day without affecting whether Maya is free at 15:00.
 */
export interface AttendedInterval {
  readonly staffId: string;
  readonly startMin: number;
  readonly endMin: number;
  readonly status: string;
}

/**
 * A digest of what the calendar contained when the offer was computed.
 *
 * WHY A DIGEST OF CONTENTS, AND NOT A COUNT.
 *
 * A count is blind to the ABA problem. One booking cancelled and another
 * created in the same window leaves the count unchanged while the world has
 * changed completely: the slot you were offered may now be taken, and the
 * conflict you were avoiding may now be gone.
 *
 * Hashing the contents catches that. There is a test for exactly this case,
 * and it is the reason this function exists at all.
 *
 * FNV-1a, not SHA. This is change detection, not a security boundary, and a
 * dependency-free hash keeps the domain runnable in a browser.
 */
export function feasibilityToken(
  intervals: readonly AttendedInterval[],
): string {
  // Sorted, so two searches that saw the same world agree regardless of the
  // order the database happened to return rows in.
  const canonical = [...intervals]
    .map((i) => `${i.staffId}|${i.startMin}|${i.endMin}|${i.status}`)
    .sort()
    .join(';');

  return `fnv1a64:${intervals.length}:${fnv1a64(canonical)}`;
}

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Did the calendar change since this offer was computed? */
export function tokenMatches(stamped: string, fresh: string): boolean {
  return stamped === fresh;
}

export type TokenVerdict =
  /** Nothing moved. Proceed. */
  | { readonly kind: 'unchanged' }
  /**
   * The calendar moved but the slot re-proved on fresh masks.
   *
   * This is NOT a conflict. The flow re-stamps the token, keeps the hold, and
   * tells the operator the calendar changed. Refusing here would punish an
   * operator for someone else's booking on the other side of the salon.
   */
  | { readonly kind: 'moved_but_still_feasible'; readonly freshToken: string }
  /** The calendar moved AND the slot is gone. This is the real conflict. */
  | { readonly kind: 'no_longer_feasible' };

/**
 * The token never refuses a booking on its own.
 *
 * Feasibility decides. The token only decides what the operator is told.
 */
export function judgeToken(
  stamped: string,
  fresh: string,
  stillFeasible: boolean,
): TokenVerdict {
  if (!stillFeasible) return { kind: 'no_longer_feasible' };
  if (tokenMatches(stamped, fresh)) return { kind: 'unchanged' };
  return { kind: 'moved_but_still_feasible', freshToken: fresh };
}

// ---------------------------------------------------------------- the TTL

/**
 * Fifteen minutes, per the front-end contract.
 *
 * The booking-flow document says ten (Table 7.8, Table 19.3). The contract the
 * front end is built against says fifteen, and it is the later of the two, so
 * it wins. Noted here rather than silently, because a reader coming from the
 * document will otherwise think this is a typo.
 */
export const HOLD_TTL_MS = 15 * 60 * 1000;

/**
 * One silent extension while a 3-D Secure challenge is in flight.
 *
 * Ten minutes, per the front-end contract; the document says five. Same
 * precedence as the TTL above.
 */
export const THREE_DS_GRACE_MS = 10 * 60 * 1000;

/** Under this, the countdown in the wizard turns urgent. */
export const URGENT_THRESHOLD_MS = 60 * 1000;

export interface HoldClock {
  readonly expiresAtMs: number;
  /** A hold may be extended exactly once, and only for a 3-D Secure challenge. */
  readonly extended: boolean;
}

/** Build the clock for a hold placed now. */
export function startHold(
  nowMs: number,
  ttlMs: number = HOLD_TTL_MS,
): HoldClock {
  return { expiresAtMs: nowMs + ttlMs, extended: false };
}

/**
 * A dead hold protects nothing.
 *
 * Expiry is exclusive: at exactly the expiry millisecond the hold is already
 * gone. Anything else means two clients disagreeing on the boundary.
 */
export function isAlive(hold: HoldClock, nowMs: number): boolean {
  return nowMs < hold.expiresAtMs;
}

export function remainingMs(hold: HoldClock, nowMs: number): number {
  return Math.max(0, hold.expiresAtMs - nowMs);
}

/** Whole seconds left, for the countdown. */
export function remainingSeconds(hold: HoldClock, nowMs: number): number {
  return Math.ceil(remainingMs(hold, nowMs) / 1000);
}

export function isUrgent(hold: HoldClock, nowMs: number): boolean {
  const left = remainingMs(hold, nowMs);
  return left > 0 && left <= URGENT_THRESHOLD_MS;
}

/**
 * Extend once, silently, while a 3-D Secure challenge is in flight.
 *
 * Returns null when the extension is refused, which is the caller's cue to
 * abort the capture rather than charge against a hold that has no protection.
 * Two reasons to refuse:
 *
 *   - it was already extended, or the customer would hold the slot forever
 *     by failing the challenge repeatedly
 *   - it is already dead, and a dead hold cannot be revived; the capacity has
 *     been back in circulation since the moment it lapsed
 */
export function extendOnce(
  hold: HoldClock,
  nowMs: number,
  graceMs: number = THREE_DS_GRACE_MS,
): HoldClock | null {
  if (hold.extended) return null;
  if (!isAlive(hold, nowMs)) return null;
  return { expiresAtMs: hold.expiresAtMs + graceMs, extended: true };
}

/** Countdown as mm:ss, for the wizard summary. */
export function formatCountdown(hold: HoldClock, nowMs: number): string {
  const total = remainingSeconds(hold, nowMs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the gate

export type HoldRefusal =
  | { readonly kind: 'hold_expired' }
  | { readonly kind: 'skill_revoked'; readonly skills: readonly string[] }
  | { readonly kind: 'slot_taken' };

export type CaptureGate =
  | { readonly kind: 'proceed'; readonly reStampToken?: string }
  | { readonly kind: 'refuse'; readonly reason: HoldRefusal };

/**
 * The four checks that stand between a capture request and a charge, in the
 * order they must run.
 *
 * The order is the point. Hold liveness first, because money is never taken
 * against a dead hold and there is no sense re-running the engine to discover
 * that. Certification next, because it is cheap. Feasibility third, because
 * it is the expensive one. The token last, and informational only, because by
 * then feasibility has already been re-proven on fresh masks.
 *
 * In every refusal branch the answer to "was anything charged?" is no.
 */
export function captureGate(input: {
  readonly hold: HoldClock;
  readonly nowMs: number;
  readonly revokedSkills: readonly string[];
  readonly stillFeasible: boolean;
  readonly stampedToken: string;
  readonly freshToken: string;
}): CaptureGate {
  if (!isAlive(input.hold, input.nowMs)) {
    return { kind: 'refuse', reason: { kind: 'hold_expired' } };
  }
  if (input.revokedSkills.length > 0) {
    return {
      kind: 'refuse',
      reason: { kind: 'skill_revoked', skills: input.revokedSkills },
    };
  }
  if (!input.stillFeasible) {
    return { kind: 'refuse', reason: { kind: 'slot_taken' } };
  }

  const verdict = judgeToken(input.stampedToken, input.freshToken, true);
  return verdict.kind === 'moved_but_still_feasible'
    ? { kind: 'proceed', reStampToken: verdict.freshToken }
    : { kind: 'proceed' };
}

/** The message the operator sees, in the product voice. */
export function describeRefusal(reason: HoldRefusal): string {
  switch (reason.kind) {
    case 'hold_expired':
      return 'This hold expired. Money is never taken against a dead hold. Re-check availability before continuing.';
    case 'skill_revoked':
      return `Certification revoked (${reason.skills.join(', ')}). The slot was dropped and nothing was charged.`;
    case 'slot_taken':
      return 'Someone took this while you were paying. Nothing was charged. Offers have refreshed.';
  }
}
