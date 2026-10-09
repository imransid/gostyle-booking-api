import type { ScannedChair } from '@domain/booking/chair-check-in';

/**
 * Which chair a customer just scanned, asked of platform, which owns the
 * chairs (ChairDirectory.ResolveChairQr, proto/floor.proto). The rules for
 * using it are platform's: gostyle-platform docs/chair-directory-team.md.
 *
 * EVERY CALL IS A SCAN. Platform records one scan of the card for every call
 * it answers, exactly as its public scan page does. So this is asked ONCE
 * per real scan: one attempt with a deadline, never retried, and never asked
 * again to redraw a screen. What a screen needs later is stored from this
 * answer.
 *
 * Platform answers what the chair is. Whether THIS booking may have it, and
 * whether somebody is already in it, is chair-check-in.ts.
 */
export type ChairLookup =
  | { readonly kind: 'found'; readonly chair: ScannedChair }
  /**
   * Not a card platform ever printed (NOT_FOUND), or not a token at all:
   * empty or over 128 characters (INVALID_ARGUMENT). Platform wrote no scan.
   */
  | { readonly kind: 'unknown_card' }
  /**
   * NO ANSWER, which is not "no": platform down, slow, not yet serving the
   * call, or refusing this service's key. The adapter has logged why. Never
   * a reason to raise the request without the chair.
   */
  | { readonly kind: 'unavailable'; readonly error: string };

export interface ChairDirectory {
  /**
   * @param token      the raw token off the card, exactly as scanned: not
   *                   trimmed, and not judged here; platform judges it
   * @param userAgent  the app's, passed through to the scan row; null when
   *                   unknown
   */
  resolve(token: string, userAgent: string | null): Promise<ChairLookup>;
}

export const CHAIR_DIRECTORY = Symbol('CHAIR_DIRECTORY');
