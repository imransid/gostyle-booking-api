/**
 * The Recurring tab (step 5): the order of its rows, and what one row
 * carries. Pure, so both are tested without a database.
 *
 * A row is a whole routine, not one visit: the hub's summary fields and
 * nothing per visit. The visits, the money and the buttons are in the hub
 * (GET /v1/mobile-booking/series/:id), which the row opens.
 */

/** What the order needs to know about a routine. */
export interface RoutineOrderFacts {
  readonly status: string;
  readonly created_at: string;
  readonly next_session: { readonly start_time: string | null } | null;
}

/** Still running: shown first, by the next visit. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'PAUSED']);

/**
 * Live routines first (ACTIVE and PAUSED), the soonest next visit first and
 * one with no next visit last. Then the rest (ENDED), the newest first.
 *
 * Instants, not strings: two salons can carry two offsets, and 10:00+04:00
 * is later than 11:00+06:00.
 *
 * Returns a new array; the input is left as it was.
 */
export function sortRoutines<T extends RoutineOrderFacts>(
  routines: readonly T[],
): T[] {
  return [...routines].sort((a, b) => {
    const aLive = LIVE_STATUSES.has(a.status);
    const bLive = LIVE_STATUSES.has(b.status);
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (aLive) return compare(nextVisitMs(a), nextVisitMs(b));
    return compare(Date.parse(b.created_at), Date.parse(a.created_at));
  });
}

function nextVisitMs(routine: RoutineOrderFacts): number {
  const at = routine.next_session?.start_time;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function compare(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The hub fields a Recurring tab row carries, in this order. */
export const ROUTINE_ROW_FIELDS = [
  'id',
  'booking_type',
  'salon_id',
  'status',
  'frequency',
  'time',
  'stylist',
  'services',
  'payment_plan',
  'counts',
  'next_session',
  'created_at',
] as const;

export type RoutineRowField = (typeof ROUTINE_ROW_FIELDS)[number];

/** One row of the tab: the hub's summary fields, nothing per visit. */
export function routineRow<T extends Record<RoutineRowField, unknown>>(
  routine: T,
): Pick<T, RoutineRowField> {
  return Object.fromEntries(
    ROUTINE_ROW_FIELDS.map((field) => [field, routine[field]]),
  ) as Pick<T, RoutineRowField>;
}
