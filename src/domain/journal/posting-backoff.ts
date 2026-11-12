/**
 * How long a posting waits after its n-th failed attempt.
 *
 * 10s, doubling, capped at 10 minutes, and NO ATTEMPT LIMIT. A failure that
 * reaches here is one the platform may yet answer -- it is down for a
 * deploy, or it broke while answering -- and the platform will come back. A
 * cap on attempts would dead-letter every posting made during a long deploy,
 * which is money in the bank and not in the books. A posting the platform
 * REFUSED never reaches here: it parks.
 */
const FIRST_MS = 10_000;
const CAP_MS = 10 * 60_000;

export function postingBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return FIRST_MS;
  // 2^6 * 10s is already past the cap; stop doubling before it overflows.
  const doublings = Math.min(Math.floor(attempts) - 1, 6);
  return Math.min(FIRST_MS * 2 ** doublings, CAP_MS);
}
