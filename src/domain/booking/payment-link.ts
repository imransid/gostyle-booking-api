/**
 * The payment link window.
 *
 * A link is a promise to hold a slot while someone pays. The window is what
 * stops that promise being open-ended: an unpaid link holds a professional
 * and a chair exactly as a confirmed booking does, and without a closing
 * time it holds them until the day itself.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The longest a link is ever good for. */
export const LINK_WINDOW_MS = 6 * HOUR_MS;

/**
 * And it always closes at least this long before the start.
 *
 * Two hours is the same boundary the cancellation policy uses, and for the
 * same reason: inside it the salon can no longer resell the slot, so holding
 * it for someone who has not paid costs the visit outright.
 */
export const LINK_CUTOFF_BEFORE_START_MS = 2 * HOUR_MS;

export type LinkWindow =
  | {
      readonly kind: 'open';
      readonly expiresAtMs: number;
      /** The half-time reminder. */
      readonly remindAtMs: number;
      readonly capped: 'six_hours' | 'start_minus_two';
    }
  /**
   * The start is too close for a link to mean anything.
   *
   * The specification gives the window as "the shorter of six hours and the
   * time until two hours before the start" and does not say what happens when
   * that is already in the past. Issuing a link that expired before it was
   * sent is the worst answer: the customer gets a dead link and the salon
   * holds the slot until a sweeper notices.
   *
   * So this is a distinct outcome rather than a zero-length window, and the
   * caller can refuse the link and ask for immediate payment instead.
   */
  | { readonly kind: 'too_late'; readonly minutesPastCutoff: number };

export function linkWindow(nowMs: number, startAtMs: number): LinkWindow {
  const sixHours = nowMs + LINK_WINDOW_MS;
  const beforeStart = startAtMs - LINK_CUTOFF_BEFORE_START_MS;

  if (beforeStart <= nowMs) {
    return {
      kind: 'too_late',
      minutesPastCutoff: Math.ceil((nowMs - beforeStart) / 60_000),
    };
  }

  const expiresAtMs = Math.min(sixHours, beforeStart);
  return {
    kind: 'open',
    expiresAtMs,
    // Half way between now and the close, so a customer who has forgotten
    // gets one nudge with time left to act on it.
    remindAtMs: nowMs + Math.floor((expiresAtMs - nowMs) / 2),
    capped: expiresAtMs === sixHours ? 'six_hours' : 'start_minus_two',
  };
}
