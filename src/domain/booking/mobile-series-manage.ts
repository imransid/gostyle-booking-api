import type { ManageClaim, PickClaim } from './mobile-series-contract';

/**
 * PATCH /v1/mobile-booking/series/:id (step 6): the body, as the app sent
 * it, into the contract's claim. Only the TYPES are read here: a field of
 * the wrong type is simply absent. What the values must be is checkManage's
 * job, which answers in the contract's envelope.
 */
export function manageClaimFrom(body: unknown): ManageClaim {
  const b: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const str = (key: string): string | null =>
    typeof b[key] === 'string' ? b[key] : null;
  const strs = (key: string): string[] | null => {
    const v = b[key];
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  };
  const picks: PickClaim[] = Array.isArray(b.picks)
    ? (b.picks as unknown[]).flatMap((p) => {
        if (typeof p !== 'object' || p === null) return [];
        const q = p as Record<string, unknown>;
        return typeof q.index === 'number' &&
          typeof q.date === 'string' &&
          typeof q.time === 'string'
          ? [
              {
                index: q.index,
                date: q.date,
                time: q.time,
                stylistId:
                  typeof q.stylist_id === 'string' ? q.stylist_id : null,
              },
            ]
          : [];
      })
    : [];
  return {
    action: str('action') ?? '',
    dryRun: b.dry_run === true,
    sessionIds: strs('session_ids'),
    sessionId: str('session_id'),
    date: str('date'),
    time: str('time'),
    stylistId: str('stylist_id'),
    frequency: str('frequency'),
    picks,
    sessions: typeof b.sessions === 'number' ? b.sessions : null,
    dates: strs('dates'),
    until: str('until'),
    reason: str('reason'),
    note: str('note'),
  };
}

/** Why SKIP cancelled a session's booking (booking_status_history.reason). */
export const SKIP_REASON = 'Skipped in the app, as part of a routine.';

/** Why RESCHEDULE moved a session's booking (booking_status_history.reason). */
export const RESCHEDULE_REASON = 'Moved in the app, as part of a routine.';

/** EXTEND: the first new session's number, after every session the routine has. */
export function nextIndex(indexes: readonly number[]): number {
  return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
}

/** EXTEND: the day to count on from, the routine's latest session day. */
export function lastDay(days: readonly string[]): string | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return sorted[sorted.length - 1]!;
}

/**
 * EXTEND a CUSTOM routine: each new day must be after today, and not a day
 * another session of the routine already has (to come, or done). The first
 * that is not, or null.
 */
export function customExtendRefusal(
  days: readonly string[],
  today: string,
  taken: ReadonlySet<string>,
): {
  readonly field: string;
  readonly code: 'date_out_of_range' | 'session_day_taken';
  readonly message: string;
} | null {
  for (const [i, d] of days.entries()) {
    if (d <= today) {
      return {
        field: `dates[${i}]`,
        code: 'date_out_of_range',
        message: `${d} is not after today. Pick days still to come.`,
      };
    }
    if (taken.has(d)) {
      return {
        field: `dates[${i}]`,
        code: 'session_day_taken',
        message: `Another session of this routine is already on ${d}.`,
      };
    }
  }
  return null;
}
