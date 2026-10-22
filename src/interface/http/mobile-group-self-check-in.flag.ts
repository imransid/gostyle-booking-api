/**
 * A party member checks in for their own lane, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_SELF_CHECK_IN=true` turns it on; anything
 * else, a typo included, is off. Read on every request rather than once at
 * boot, the same as MOBILE_GROUP_CHECK_IN, so a test can flip it and a
 * restart is all a deploy needs.
 *
 * It adds no route. On, the party read tells the caller which member row is
 * theirs (`is_me`) and gives them their own lane's id (`booking_id`), so the app
 * can send them to the single check-in route that is already live. Off, the
 * party read is exactly what it was. So there is no guard here: nothing
 * needs a 404.
 */
export const MOBILE_GROUP_SELF_CHECK_IN = (): boolean =>
  (process.env.MOBILE_GROUP_SELF_CHECK_IN ?? '').trim().toLowerCase() ===
  'true';
