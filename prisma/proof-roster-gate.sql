\set ON_ERROR_STOP off
\pset pager off

\set branch '''11111111-1111-1111-1111-111111111111'''
\set maya   '''22222222-2222-2222-2222-222222222222'''
\set chg    '''eeeeeeee-0000-0000-0000-000000000001'''

\echo ''
\echo '=== SETUP: Maya goes off on Friday. Two bookings disturbed. ==='
INSERT INTO roster_change (id, branch_id, trading_day, kind, staff_id, reason, updated_at)
VALUES (:chg, :branch, '2026-09-04', 'shift_conflict', :maya, 'called in sick', now());

INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state, rung, resolved_at)
VALUES ('ffffffff-0000-0000-0000-000000000001', :chg, gen_random_uuid(), 'GS-2001',
        'auto_repaired', 'same_minute_other_professional', now());

INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state, proposal)
VALUES ('ffffffff-0000-0000-0000-000000000002', :chg, gen_random_uuid(), 'GS-2002',
        'open', '{"refundFils":24000,"goodwillFils":4800}'::jsonb);
\echo '--> one auto-repaired, one still open'

\echo ''
\echo '=== TEST 1: commit while one booking is unresolved. MUST FAIL. ==='
UPDATE roster_change SET committed_at = now() WHERE id = :chg;

\echo ''
\echo '=== TEST 2: a shift conflict naming no professional. MUST FAIL. ==='
INSERT INTO roster_change (id, branch_id, trading_day, kind, reason, updated_at)
VALUES (gen_random_uuid(), :branch, '2026-09-04', 'shift_conflict', 'who?', now());

\echo ''
\echo '=== TEST 3: a closure sweep naming a professional. MUST FAIL. ==='
INSERT INTO roster_change (id, branch_id, trading_day, kind, staff_id, reason, updated_at)
VALUES (gen_random_uuid(), :branch, '2026-09-04', 'closure_sweep', :maya, 'holiday', now());

\echo ''
\echo '=== TEST 4: a settled item with no resolved_at. MUST FAIL. ==='
INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state)
VALUES (gen_random_uuid(), :chg, gen_random_uuid(), 'GS-2003', 'resolved');

\echo ''
\echo '=== TEST 5: a proposal left on a settled item. MUST FAIL. ==='
INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state, resolved_at, proposal)
VALUES (gen_random_uuid(), :chg, gen_random_uuid(), 'GS-2004', 'resolved', now(),
        '{"refundFils":1}'::jsonb);

\echo ''
\echo '=== TEST 6: the same booking twice on one change. MUST FAIL. ==='
INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state, proposal)
SELECT gen_random_uuid(), :chg, booking_id, 'GS-2002', 'open', NULL
  FROM roster_change_item WHERE booking_code = 'GS-2002';

\echo ''
\echo '=== TEST 7: resolve the open item, then commit. MUST SUCCEED. ==='
UPDATE roster_change_item
   SET state = 'overridden', resolved_at = now(), proposal = NULL
 WHERE id = 'ffffffff-0000-0000-0000-000000000002';
UPDATE roster_change SET committed_at = now() WHERE id = :chg;
SELECT committed_at IS NOT NULL AS committed FROM roster_change WHERE id = :chg;

\echo ''
\echo '=== TEST 8: re-commit an already committed change. MUST FAIL. ==='
UPDATE roster_change SET committed_at = now() WHERE id = :chg;

\echo ''
\echo '=== TEST 9: add an item to a committed change. MUST FAIL. ==='
INSERT INTO roster_change_item (id, change_id, booking_id, booking_code, state)
VALUES (gen_random_uuid(), :chg, gen_random_uuid(), 'GS-2005', 'open');

\echo ''
\echo '=== TEST 10: reopen an item on a committed change. MUST FAIL. ==='
UPDATE roster_change_item SET state = 'open', resolved_at = NULL
 WHERE id = 'ffffffff-0000-0000-0000-000000000001';

\echo ''
\echo '=== CLEANUP ==='
DELETE FROM roster_change WHERE id = :chg;
SELECT count(*) AS remaining FROM roster_change_item WHERE change_id = :chg;
