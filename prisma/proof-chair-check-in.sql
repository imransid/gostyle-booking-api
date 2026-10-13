\set ON_ERROR_STOP off
\pset pager off

-- check_in_request's chair columns, made to fail on purpose (CLAUDE.md 5).
--
--   psql <throwaway db> -X -f prisma/proof-chair-check-in.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls. Cleans up
-- after itself.
--
-- Rows are written EXPIRED (answered by the system) unless a test is about
-- waiting, so check_in_request_one_waiting_uq stays out of the way: these
-- tests are about the chair, not about one claim at a time.

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set bk      '''cccccccc-0000-4000-8000-000000000002'''
\set chair   '''0192a3b4-0000-7000-8000-000000000007'''

\echo ''
\echo '=== SETUP: GS-PROOF-CHAIR, Sunday 11 October 10:00 Dhaka (04:00 UTC), confirmed ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-PROOF-CHAIR', :branch, :sara, 'confirmed', 'deposit_paid',
        '2026-10-11', '2026-10-11 04:00:00+00', '2026-10-11 05:00:00+00',
        600, 60, 48000, 24000, 'mobile', now());

\echo ''
\echo '=== TEST 1: a whole chair: id, number and zone. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_id, chair_number, chair_zone_name)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        :chair, '7', 'Window section');

\echo ''
\echo '=== TEST 2: a chair with no zone. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_id, chair_number)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        :chair, '7');

\echo ''
\echo '=== TEST 3: no chair at all, as every request before chairs. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, raised_by_kind, raised_by_id)
VALUES (gen_random_uuid(), :bk, 'customer', :sara);

\echo ''
\echo '=== TEST 4: a chair id with no number: the desk cannot read it. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_id)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        :chair);

\echo ''
\echo '=== TEST 5: a number with no chair id: nobody can match it. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_number)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        '7');

\echo ''
\echo '=== TEST 6: a blank number. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_id, chair_number)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        :chair, '   ');

\echo ''
\echo '=== TEST 7: a zone with no chair. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              chair_zone_name)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        'Window section');

\echo ''
\echo '=== TEST 8: the waiting request (TEST 3) given a chair id alone, later. MUST FAIL. ==='
UPDATE check_in_request SET chair_id = :chair
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 9: a whole chair losing its number, later. MUST FAIL. ==='
UPDATE check_in_request SET chair_number = NULL
 WHERE booking_id = :bk AND chair_zone_name = 'Window section';

\echo ''
\echo '=== RESULT: three rows, the two chairs and the pass, as written ==='
SELECT state, chair_id IS NOT NULL AS has_chair, chair_number, chair_zone_name
  FROM check_in_request WHERE booking_id = :bk ORDER BY raised_at, id;

\echo ''
\echo '=== CLEANUP ==='
DELETE FROM check_in_request WHERE booking_id = :bk;
DELETE FROM booking WHERE id = :bk;
