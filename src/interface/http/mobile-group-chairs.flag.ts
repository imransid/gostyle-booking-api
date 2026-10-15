/**
 * Each member's chair on the party read, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_CHAIRS=true` turns it on; anything else, a
 * typo included, is off. Read on every request rather than once at boot, the
 * same as MOBILE_GROUP_CHECK_IN, so a test can flip it and a restart is all a
 * deploy needs.
 *
 * It adds no route. On, every member row of GET
 * /v1/mobile-booking/group/:groupId carries `chair`: the chair claimed by
 * that lane's latest check-in request, or null. Off, the read is exactly what
 * it was, key for key. So there is no guard here: nothing needs a 404.
 */
export const MOBILE_GROUP_CHAIRS = (): boolean =>
  (process.env.MOBILE_GROUP_CHAIRS ?? '').trim().toLowerCase() === 'true';
