/**
 * What a booking is worth when the catalogue cannot price it.
 *
 * THE BUG THIS EXISTS FOR. `GET /booking/:id` and `PATCH /booking/:id` both
 * re-quoted the booking, and the quote handler throws `Unknown service` for
 * a service the LIVE catalogue cannot resolve — retired, renamed, moved to
 * another branch, or a request that arrived without the tenant the lookup
 * needs. So a booking that plainly existed, with money owed on it, answered
 * `404 BOOKING_NOT_FOUND` to both "show me my booking" and "here is the
 * payment", naming a service rather than admitting it could not price it.
 *
 * The breakdown stored on the row is what the customer was shown and agreed
 * to, and create verified it against the quote before writing it, so the two
 * agree wherever both exist.
 *
 * Pure, and tested on its own, because it decides what someone is told they
 * owe.
 */
export interface StoredBreakdown {
  /** The net total, before tax. Null on a row written without a breakdown. */
  readonly netFils: number | null;
  readonly taxFils: number | null;
  readonly discountFils: number | null;
}

/**
 * NULL RATHER THAN `price_fils`, which is the net figure with no VAT in it.
 * Reporting that as the total would understate every booking by the tax, and
 * understating what someone owes is worse than saying the number is
 * unavailable — the caller refuses the payment instead of checking it
 * against a number nobody has.
 *
 * A null tax or discount means NONE; only a null net means the breakdown is
 * absent altogether. The two columns are nullable for rows written before
 * the breakdown existed.
 */
export function storedTotalFils(b: StoredBreakdown): number | null {
  if (b.netFils === null) return null;
  return b.netFils + (b.taxFils ?? 0) - (b.discountFils ?? 0);
}
