\set ON_ERROR_STOP off
\pset pager off

-- check_in_request, made to fail on purpose (CLAUDE.md 5).
--
--   docker exec -i <postgres> psql -U gostyle -d <db> < prisma/proof-check-in-request.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls. Cleans up
-- after itself.

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set desk    '''33333333-3333-4333-8333-333333333333'''
\set bk      '''cccccccc-0000-4000-8000-000000000001'''

\echo ''
\echo '=== SETUP: GS-PROOF-CI, Sunday 11 October 10:00 Dhaka (04:00 UTC), confirmed ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-PROOF-CI', :branch, :sara, 'confirmed', 'deposit_paid',
        '2026-10-11', '2026-10-11 04:00:00+00', '2026-10-11 05:00:00+00',
        600, 60, 48000, 24000, 'mobile', now());

\echo ''
\echo '=== TEST 1: the customer says they are here. MUST SUCCEED. ==='
INSERT INTO check_in_request (id, booking_id, raised_by_kind, raised_by_id)
VALUES (gen_random_uuid(), :bk, 'customer', :sara);

\echo ''
\echo '=== TEST 2: a second waiting request on the same booking. MUST FAIL. ==='
INSERT INTO check_in_request (id, booking_id, raised_by_kind, raised_by_id)
VALUES (gen_random_uuid(), :bk, 'customer', :sara);

\echo ''
\echo '=== TEST 3: still waiting, but with an answer time. MUST FAIL. ==='
UPDATE check_in_request SET decided_at = now(), decided_by_kind = 'staff',
                            decided_by_id = :desk
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 4: approved with no answer time. MUST FAIL. ==='
UPDATE check_in_request SET state = 'approved'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 5: an answer time with nobody behind it. MUST FAIL. ==='
UPDATE check_in_request SET state = 'expired', decided_at = now()
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 6: approved by the system: a check-in nobody looked at. MUST FAIL. ==='
UPDATE check_in_request SET state = 'approved', decided_at = now(),
                            decided_by_kind = 'system'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 7: approved by the customer who raised it. MUST FAIL. ==='
UPDATE check_in_request SET state = 'approved', decided_at = now(),
                            decided_by_kind = 'customer', decided_by_id = :sara
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 8: expired by a member of staff. MUST FAIL. ==='
UPDATE check_in_request SET state = 'expired', decided_at = now(),
                            decided_by_kind = 'staff', decided_by_id = :desk,
                            reason = 'x'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 9: approved by staff, but which staff? MUST FAIL. ==='
UPDATE check_in_request SET state = 'approved', decided_at = now(),
                            decided_by_kind = 'staff'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 10: closed by the system, naming a person. MUST FAIL. ==='
UPDATE check_in_request SET state = 'closed', decided_at = now(),
                            decided_by_kind = 'system', decided_by_id = :desk
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 11: rejected with a blank reason. MUST FAIL. ==='
UPDATE check_in_request SET state = 'rejected', decided_at = now(),
                            decided_by_kind = 'staff', decided_by_id = :desk,
                            reason = '   '
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 12: rejected by the desk, saying why. MUST SUCCEED. ==='
UPDATE check_in_request SET state = 'rejected', decided_at = now(),
                            decided_by_kind = 'staff', decided_by_id = :desk,
                            reason = 'Not at the salon'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 13: with nothing waiting, a new waiting row is the table''s to allow. MUST SUCCEED. ==='
-- "No raise after a rejection" is the raise's rule (raiseVerdict), not the
-- table's: the table only promises one claim at a time.
INSERT INTO check_in_request (id, booking_id, raised_by_kind, raised_by_id)
VALUES (gen_random_uuid(), :bk, 'customer', :sara);

\echo ''
\echo '=== TEST 14: the lapse job expires it, as the system, with no person. MUST SUCCEED. ==='
UPDATE check_in_request SET state = 'expired', decided_at = now(),
                            decided_by_kind = 'system',
                            reason = 'Nobody answered before the booking ended.'
 WHERE booking_id = :bk AND state = 'waiting';

\echo ''
\echo '=== TEST 15: the booking cannot be deleted from under its requests. MUST FAIL. ==='
DELETE FROM booking WHERE id = :bk;

\echo ''
\echo '=== RESULT: one rejected, one expired, nothing waiting ==='
SELECT state, decided_by_kind, reason
  FROM check_in_request WHERE booking_id = :bk ORDER BY raised_at;

\echo ''
\echo '=== CLEANUP ==='
DELETE FROM check_in_request WHERE booking_id = :bk;
DELETE FROM booking WHERE id = :bk;
