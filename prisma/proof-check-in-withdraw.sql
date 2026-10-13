\set ON_ERROR_STOP off
\pset pager off

-- check_in_request's WITHDRAWN, made to fail on purpose (CLAUDE.md 5).
--
--   psql <throwaway db> -X -f prisma/proof-check-in-withdraw.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls. Cleans up
-- after itself.
--
-- Rows are written answered unless a test is about waiting, so
-- check_in_request_one_waiting_uq stays out of the way: these tests are
-- about who may take a request back, not about one claim at a time.

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set omar    '''44444444-4444-4444-8444-444444444444'''
\set desk    '''33333333-3333-4333-8333-333333333333'''
\set bk      '''cccccccc-0000-4000-8000-000000000003'''

\echo ''
\echo '=== SETUP: GS-PROOF-WITHDRAW, Sara''s, Sunday 11 October 10:00 Dhaka (04:00 UTC), confirmed ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-PROOF-WITHDRAW', :branch, :sara, 'confirmed', 'deposit_paid',
        '2026-10-11', '2026-10-11 04:00:00+00', '2026-10-11 05:00:00+00',
        600, 60, 48000, 24000, 'mobile', now());

\echo ''
\echo '=== TEST 1: withdrawn by Sara, who raised it. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              decided_by_id)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, now(),
        'customer', :sara);

\echo ''
\echo '=== TEST 2: Sara waits, then takes it back: the route''s own UPDATE. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, raised_by_kind, raised_by_id)
VALUES (gen_random_uuid(), :bk, 'customer', :sara);
UPDATE check_in_request
   SET state = 'withdrawn', decided_at = now(), decided_by_kind = 'customer',
       decided_by_id = :sara
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 3: expired by the system, the lapse job''s write. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              reason)
VALUES (gen_random_uuid(), :bk, 'expired', 'customer', :sara, now(), 'system',
        'Nobody answered before the booking ended.');

\echo ''
\echo '=== TEST 4: withdrawn by the desk: the desk rejects, with a reason. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              decided_by_id)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, now(),
        'staff', :desk);

\echo ''
\echo '=== TEST 5: withdrawn by the system: the job never takes a claim back. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, now(),
        'system');

\echo ''
\echo '=== TEST 6: withdrawn by a customer with no id: who took it back? MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, now(),
        'customer');

\echo ''
\echo '=== TEST 7: withdrawn by Omar, who did not raise it. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              decided_by_id)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, now(),
        'customer', :omar);

\echo ''
\echo '=== TEST 8: withdrawn with no time. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_by_kind, decided_by_id)
VALUES (gen_random_uuid(), :bk, 'withdrawn', 'customer', :sara, 'customer',
        :sara);

\echo ''
\echo '=== TEST 9: approved by the customer: still the desk''s alone. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, state, raised_by_kind,
                              raised_by_id, decided_at, decided_by_kind,
                              decided_by_id)
VALUES (gen_random_uuid(), :bk, 'approved', 'customer', :sara, now(),
        'customer', :sara);

\echo ''
\echo '=== TEST 10: the expired one (TEST 3) relabelled withdrawn, later. MUST FAIL. ==='
UPDATE check_in_request SET state = 'withdrawn'
 WHERE booking_id = :bk AND state = 'expired';

\echo ''
\echo '=== RESULT: three rows, two withdrawn by Sara and one expired by the system ==='
SELECT state, decided_by_kind, decided_by_id = :sara AS by_sara, reason
  FROM check_in_request WHERE booking_id = :bk ORDER BY raised_at, id;

\echo ''
\echo '=== CLEANUP ==='
DELETE FROM check_in_request WHERE booking_id = :bk;
DELETE FROM booking WHERE id = :bk;
