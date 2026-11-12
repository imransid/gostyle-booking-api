/**
 * The POS ticket sync switches (gostyle-platform
 * docs/booking-pos-tickets-plan.md, B2). Read on every event and every tick
 * rather than once at boot, like the journal's, so a test can flip them and
 * a restart is all a deploy needs.
 *
 * OFF, NOTHING IS ENQUEUED, unlike the journal (which queues and waits).
 * A ticket opened today for a check-in from last week would be a bill for a
 * visit long over, so the switch decides at the moment the event happens:
 * turning it on starts with the next check-in, never with a backlog.
 */

/**
 * OFF BY DEFAULT. `POS_TICKET_SYNC_ENABLED=true` opens a till ticket at
 * every check-in and mirrors the visit onto it.
 */
export function posTicketSyncEnabled(
  raw = process.env.POS_TICKET_SYNC_ENABLED,
): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * `POS_TICKET_SYNC_TENANTS`: a comma-separated allow-list of tenant ids.
 * Empty (or unset) means every tenant -- the list narrows, it never widens,
 * and the step from the pilot tenant to all is deleting it.
 */
export function posTicketSyncTenants(
  raw = process.env.POS_TICKET_SYNC_TENANTS,
): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Is the till taking this tenant's booked visits?
 *
 * A booking with no tenant never syncs (the platform needs to know whose
 * till), so it is "no" here, which is also what keeps POST /settle open for
 * it (B7): a booking the till never heard of must still be settleable.
 */
export function posTicketSyncFor(
  tenantId: string | null,
  enabled = posTicketSyncEnabled(),
  tenants = posTicketSyncTenants(),
): boolean {
  if (!enabled || tenantId === null) return false;
  return tenants.length === 0 || tenants.includes(tenantId);
}
