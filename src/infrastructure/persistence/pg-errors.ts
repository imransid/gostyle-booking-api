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

/**
 * Postgres SQLSTATE 23505, unique_violation, NAMING THE COLUMN.
 *
 * Which column matters, because two very different things arrive as P2002 in
 * the confirm path and only one of them is a retry:
 *
 *   idempotency_key.key   the same request twice -> replay the booking
 *   deposit_ledger.gateway_ref  a DIFFERENT request reusing a payment intent
 *
 * Treating the second as the first looks up a replay that is not there and
 * rethrows, so a foreseeable client mistake reached the caller as a 500.
 *
 * The adapter's shape, read off a real failure rather than guessed:
 *
 *   PrismaClientKnownRequestError
 *     .code                                               "P2002"
 *     .meta.driverAdapterError.cause.originalCode         "23505"
 *     .meta.driverAdapterError.cause.constraint.fields    ["gateway_ref"]
 *
 * `meta.target` is the classic (pre-adapter) spelling and is still checked,
 * so this keeps working if the driver adapter is ever swapped out.
 */
export function isUniqueViolationOn(e: unknown, field: string): boolean {
  return uniqueViolationFields(e).includes(field);
}

/** The columns a unique violation names, or empty for any other error. */
export function uniqueViolationFields(e: unknown): readonly string[] {
  if (typeof e !== 'object' || e === null) return [];

  const err = e as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { originalCode?: unknown; constraint?: { fields?: unknown } };
      };
    };
  };

  const cause = err.meta?.driverAdapterError?.cause;
  const isUnique = err.code === 'P2002' || cause?.originalCode === '23505';
  if (!isUnique) return [];

  const fields = cause?.constraint?.fields;
  if (Array.isArray(fields)) return fields.filter((f) => typeof f === 'string');

  // Classic Prisma: meta.target, either a list of columns or a constraint
  // name as a bare string.
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.filter((t) => typeof t === 'string');
  if (typeof target === 'string') return [target];

  return [];
}
