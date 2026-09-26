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
