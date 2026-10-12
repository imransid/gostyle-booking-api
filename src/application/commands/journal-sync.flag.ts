/**
 * The journal sync switches. Read on every tick rather than once at boot,
 * like the mobile flags, so a test can flip them and a restart is all a
 * deploy needs.
 *
 * Off, nothing is sent and nothing is lost: new ledger rows wait as
 * `pending` with their own dates, and go when sending is turned on.
 */

/**
 * OFF BY DEFAULT. `JOURNAL_POSTING_ENABLED=true` sends each ledger row to
 * the platform's general ledger. Rollout: ship off, check what a booking
 * would post (GET /v1/bookings/:id/journal), then turn it on for one tenant.
 */
export function journalPostingEnabled(
  raw = process.env.JOURNAL_POSTING_ENABLED,
): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * `JOURNAL_POSTING_TENANTS`: a comma-separated allow-list of tenant ids.
 * Empty (or unset) means every tenant -- so the list narrows, it never
 * widens, and the step from "one tenant" to "all" is deleting it.
 */
export function journalPostingTenants(
  raw = process.env.JOURNAL_POSTING_TENANTS,
): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
