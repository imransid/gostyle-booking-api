\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\pset pager off

-- booking_status_history.check_in_via, made to fail on purpose (CLAUDE.md 5).
--
--   psql <throwaway db> -X -f prisma/proof-check-in-via.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls.
--
-- ONE TRANSACTION, ROLLED BACK AT THE END: the history is append-only
-- (booking_status_history_append_only), so a row written here could never
-- be deleted. ON_ERROR_ROLLBACK undoes only the failing statement, so the
-- tests after it still run.

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set desk    '''33333333-3333-4333-8333-333333333333'''
\set bk      '''cccccccc-0000-4000-8000-000000000004'''

BEGIN;

\echo ''
\echo '=== SETUP: GS-PROOF-VIA, Sara''s, confirmed ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-PROOF-VIA', :branch, :sara, 'confirmed', 'none_required',
        '2026-10-11', '2026-10-11 04:00:00+00', '2026-10-11 05:00:00+00',
        600, 60, 0, 0, 'mobile', now());

\echo ''
\echo '=== TEST 1: the desk checks Sara in on its own: staff. MUST SUCCEED. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    actor_kind, actor_id, check_in_via)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'checked_in', 'staff', :desk,
        'staff');

\echo ''
\echo '=== TEST 2: an approved request: self. MUST SUCCEED. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    actor_kind, actor_id, check_in_via)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'checked_in', 'staff', :desk,
        'self');

\echo ''
\echo '=== TEST 3: any other move, saying nothing: the undo. MUST SUCCEED. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    reason, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'checked_in', 'confirmed', 'Wrong Amira',
        'staff', :desk);

\echo ''
\echo '=== TEST 4: a check-in that does not say how: a caller that forgot. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'checked_in', 'staff', :desk);

\echo ''
\echo '=== TEST 5: how, on an undo. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    reason, actor_kind, actor_id, check_in_via)
VALUES (gen_random_uuid(), :bk, 'checked_in', 'confirmed', 'Wrong Amira',
        'staff', :desk, 'staff');

\echo ''
\echo '=== TEST 6: how, on a start. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    actor_kind, actor_id, check_in_via)
VALUES (gen_random_uuid(), :bk, 'checked_in', 'in_service', 'staff', :desk,
        'self');

\echo ''
\echo '=== TEST 7: a how that is neither: kiosk. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status,
                                    actor_kind, actor_id, check_in_via)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'checked_in', 'staff', :desk,
        'kiosk');

\echo ''
\echo '=== RESULT: the three controls, as written ==='
SELECT from_status, to_status, check_in_via
  FROM booking_status_history WHERE booking_id = :bk ORDER BY created_at, id;

\echo ''
\echo '=== THE OLD ROWS: check-ins from before, still null, and the CHECK not validated over them ==='
SELECT count(*) AS old_check_ins_without_how
  FROM booking_status_history
 WHERE to_status = 'checked_in' AND check_in_via IS NULL;
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conname = 'booking_status_history_check_in_says_how';

\echo ''
\echo '=== CLEANUP: everything above rolled back ==='
ROLLBACK;
