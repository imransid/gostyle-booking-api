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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The booking ids on a page worth asking the database about. Uuids only: a
 * row id that is not one would fail the uuid cast in SQL and turn the whole
 * list into a 500.
 */
export function bookingIdsOf(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    const id =
      typeof row === 'object' && row !== null
        ? (row as { id?: unknown }).id
        : undefined;
    return typeof id === 'string' && UUID.test(id) ? [id] : [];
  });
}

/**
 * Upcoming and Archive (step 5): every row gets `series_id`, the app routine
 * its visit belongs to, or null, so the app can open the routine from one
 * of its visits. `byBooking` maps a booking id to its app routine.
 *
 * New rows: the page it was given is left as it was.
 */
export function withSeriesIds(
  rows: readonly unknown[],
  byBooking: ReadonlyMap<string, string>,
): unknown[] {
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) return row;
    const id = (row as { id?: unknown }).id;
    return {
      ...row,
      series_id: typeof id === 'string' ? (byBooking.get(id) ?? null) : null,
    };
  });
}
