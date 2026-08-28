/**
 * Postgres errors, recognised properly.
 *
 * Neither the hold nor the booking repository owns this question. Every path
 * that writes a reservation has to ask it, and there were three copies before
 * this file: one private to hold.repository with the best explanation, one
 * exported from booking.repository, and one written from memory in
 * series.repository that only checked the top-level code. That third copy
 * missed Prisma's wrapped shape, so a lost race arrived as a 500 in the middle
 * of a materialisation run.
 */

/**
 * Postgres SQLSTATE 23P01, exclusion_violation.
 *
 * Prisma 7 reports it as its own P2039 and buries the real code three levels
 * down, so the path is worth spelling out rather than pattern-matching text:
 *
 *   PrismaClientKnownRequestError
 *     .code                                  "P2039"
 *     .meta.driverAdapterError.cause.code    "23P01"   <- the truth
 *
 * An earlier version matched `message.includes('exclusion constraint')` and
 * quietly reported a dead connection pool as "someone took your slot". A wrong
 * business answer is worse than a 500, because nobody investigates a 409.
 * Match the code, and let anything unrecognised throw.
 */
export function isExclusionViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  if ((e as { code?: unknown }).code === '23P01') return true;
  return (
    (e as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } })
      .meta?.driverAdapterError?.cause?.code === '23P01'
  );
}
