/**
 * A customer may not cancel or move one lane of an app party on its own, on
 * or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_LANE_GUARD=true` turns it on; anything else,
 * a typo included, is off. Read on every request rather than once at boot,
 * the same as MOBILE_GROUP_CHECK_IN, so a test can flip it and a restart is
 * all a deploy needs.
 *
 * It adds no route. On, POST /v1/bookings/:id/cancel and /reschedule refuse
 * a CUSTOMER whose booking is a lane of an app party (source 'mobile'): a
 * party is cancelled together, by the booker, on the party's own route. Off,
 * both routes are exactly what they were. Staff, and a desk party's lanes,
 * are never touched either way.
 */
export const MOBILE_GROUP_LANE_GUARD = (): boolean =>
  (process.env.MOBILE_GROUP_LANE_GUARD ?? '').trim().toLowerCase() === 'true';
