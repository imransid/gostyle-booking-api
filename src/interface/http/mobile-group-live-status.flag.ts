/**
 * A party's status follows ANY lane still confirmed, not the booker's alone,
 * on or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_LIVE_STATUS=true` turns it on; anything else,
 * a typo included, is off. Read on every request rather than once at boot,
 * the same as MOBILE_GROUP_CHECK_IN, so a test can flip it and a restart is
 * all a deploy needs.
 *
 * It adds no route and no key. On, the party's `status` and `status_detail`
 * (the GROUP row of My Bookings, and the party read) say CONFIRMED while any
 * lane is still confirmed, so once the booker is checked in the rest of the
 * party can still be checked in from the app. Off, both follow the booker's
 * lane, exactly as before. Its own switch, apart from MOBILE_GROUP_CHAIRS,
 * because it changes a value the app already reads.
 */
export const MOBILE_GROUP_LIVE_STATUS = (): boolean =>
  (process.env.MOBILE_GROUP_LIVE_STATUS ?? '').trim().toLowerCase() === 'true';
