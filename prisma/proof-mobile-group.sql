-- Live proof of a mobile group booking (POST /v1/mobile-booking/group).
--
-- Run it against a party the API has just created, never against a seeded
-- one: the point is to see what the running code actually wrote.
--
--   psql "$DATABASE_URL" -v gid="'<group id from the 201>'" -f prisma/proof-mobile-group.sql
--
-- The CHECKs print what is stored. Every TEST is a write that MUST FAIL: the
-- expected errors print in order, and a silent success shows up as a missing
-- error (CLAUDE.md 5). Nothing here is left behind: the failing writes never
-- land, and the one row the proof adds (a hold) is deleted at the end.

\set ON_ERROR_STOP off
\pset pager off

\echo ''
\echo '=== CHECK 1: the group is the mobile one, with its deposit percent ==='
SELECT id, status, source, deposit_percent, active_count
  FROM booking_group WHERE id = :gid;

\echo ''
\echo '=== CHECK 2: one booking per member, confirmed, paid at the salon, in the order sent ==='
SELECT gp.position, gp.client_ref, gp.age_group, gp.share_fils,
       b.code, b.status, b.payment_status, b.channel,
       b.price_fils, b.net_fils, b.tax_fils, b.deposit_fils,
       b.link_expires_at IS NOT NULL AS has_window,
       (SELECT count(*) FROM booking_item i WHERE i.booking_id = b.id) AS items,
       (SELECT count(*) FROM booking_product p WHERE p.booking_id = b.id) AS products
  FROM group_participant gp
  JOIN booking b ON b.id = gp.booking_id
 WHERE gp.group_id = :gid
 ORDER BY gp.position;

\echo ''
\echo '=== CHECK 3: every member holds their own time, on their own first item ==='
SELECT b.code,
       sr.blocking AS stylist_blocking,
       sr.booking_item_id = first_item.id AS stylist_on_first_item,
       rr.blocking AS chair_blocking,
       rr.booking_item_id = first_item.id AS chair_on_first_item,
       sr.hold_id IS NULL AND rr.hold_id IS NULL AS off_the_hold
  FROM booking b
  JOIN LATERAL (SELECT id FROM booking_item WHERE booking_id = b.id
                 ORDER BY position LIMIT 1) first_item ON true
  JOIN staff_reservation sr ON sr.booking_item_id = first_item.id
  JOIN resource_reservation rr ON rr.booking_item_id = first_item.id
 WHERE b.group_id = :gid
 ORDER BY b.code;

\echo ''
\echo '=== CHECK 4: the hold is gone, and nothing still hangs off it ==='
SELECT count(*) AS holds_left
  FROM hold WHERE feasibility_token = 'group:' || :gid;

\echo ''
\echo '=== CHECK 5: nothing the payment link sweeper could ever expire (must be 0) ==='
SELECT count(*) AS sweepable
  FROM booking
 WHERE group_id = :gid
   AND status = 'pending_payment'
   AND link_expires_at IS NOT NULL;

\echo ''
\echo '=== SETUP: a desk hold, to try to take a member stylist ==='
INSERT INTO hold (id, branch_id, customer_id, trading_day, feasibility_token, expires_at)
SELECT 'fe11fe11-0000-4000-8000-000000000001', b.branch_id, NULL, b.trading_day,
       'proof-mobile-group', now() + interval '10 minutes'
  FROM booking b WHERE b.group_id = :gid LIMIT 1;

\echo ''
\echo '=== TEST 1: the same stylist, the same time, for someone else. MUST FAIL. ==='
INSERT INTO staff_reservation (id, hold_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
SELECT gen_random_uuid(), 'fe11fe11-0000-4000-8000-000000000001',
       sr.branch_id, sr.staff_id, sr.trading_day, 'active',
       sr.start_at, sr.end_at, sr.start_minute, sr.duration_min
  FROM booking b
  JOIN booking_item i ON i.booking_id = b.id
  JOIN staff_reservation sr ON sr.booking_item_id = i.id
 WHERE b.group_id = :gid
 LIMIT 1;

\echo ''
\echo '=== TEST 2: an age group the price rule does not know. MUST FAIL. ==='
UPDATE group_participant SET age_group = 'teen' WHERE group_id = :gid;

\echo ''
\echo '=== TEST 3: a maker of groups nobody declared. MUST FAIL. ==='
UPDATE booking_group SET source = 'kiosk' WHERE id = :gid;

\echo ''
\echo '=== TEST 4: a deposit of 150 percent. MUST FAIL. ==='
UPDATE booking_group SET deposit_percent = 150 WHERE id = :gid;

\echo ''
\echo '=== TEST 5: a negative ref. MUST FAIL. ==='
UPDATE group_participant SET client_ref = -1 WHERE group_id = :gid;

\echo ''
\echo '=== CLEANUP: the proof hold goes, the party is untouched ==='
DELETE FROM hold WHERE id = 'fe11fe11-0000-4000-8000-000000000001';
SELECT count(*) AS members_still_booked
  FROM booking WHERE group_id = :gid AND status = 'confirmed';
