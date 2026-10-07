-- Proof for 20261007120000_start_checks_follow_the_grid (CLAUDE.md 5).
--
-- The three start CHECKs used to pin a start to 10:00-22:00. They now guard
-- the clock day, 00:00 to 23:59, because the trading day is per branch and
-- the engine checks it. Every MUST SUCCEED below was refused before this
-- migration; every MUST FAIL is the new bound doing its job.
--
-- Run against a database with every migration applied. Everything happens
-- inside one transaction and is rolled back: nothing is left behind.

\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set svc     '''77777777-7777-7777-7777-777777777777'''
\set ser     '''cccccccc-0000-0000-0000-0000000000a1'''

BEGIN;

\echo ''
\echo '=== SETUP: Dana every Tuesday at 18:00 ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, updated_at)
VALUES (:ser, :branch, :dana, '2026-10-06', 1080,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, now());
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, updated_at)
VALUES ('dddddddd-0000-0000-0000-0000000000a1', :ser, 0, '2026-10-13', 1080, 'planned', now());
\echo '--> series and one occurrence created'

\echo ''
\echo '=== TEST 1: a series at 22:30, for a branch open until 23:00. MUST SUCCEED ==='
SAVEPOINT t1;
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-10-06', 1350,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, now())
RETURNING start_min AS t1_start_min;
ROLLBACK TO SAVEPOINT t1;

\echo ''
\echo '=== TEST 2: a series at 09:00, for a branch that opens at 09:00. MUST SUCCEED ==='
SAVEPOINT t2;
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-10-06', 540,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, now())
RETURNING start_min AS t2_start_min;
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '=== TEST 3: a series at 00:00, for a branch open 24 hours. MUST SUCCEED ==='
SAVEPOINT t3;
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-10-06', 0,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, now())
RETURNING start_min AS t3_start_min;
ROLLBACK TO SAVEPOINT t3;

\echo ''
\echo '=== TEST 4: a series at 24:00. MUST FAIL (series_start_inside_clock_day) ==='
SAVEPOINT t4;
UPDATE booking_series SET start_min = 1440 WHERE id = :ser;
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== TEST 5: a series at minute -5. MUST FAIL (series_start_inside_clock_day) ==='
SAVEPOINT t5;
UPDATE booking_series SET start_min = -5 WHERE id = :ser;
ROLLBACK TO SAVEPOINT t5;

\echo ''
\echo '=== TEST 6: an occurrence moved to 23:00. MUST SUCCEED ==='
SAVEPOINT t6;
UPDATE series_occurrence SET planned_start_min = 1380
 WHERE series_id = :ser
RETURNING planned_start_min AS t6_planned_start_min;
ROLLBACK TO SAVEPOINT t6;

\echo ''
\echo '=== TEST 7: an occurrence at 24:00. MUST FAIL (occurrence_start_inside_clock_day) ==='
SAVEPOINT t7;
UPDATE series_occurrence SET planned_start_min = 1440 WHERE series_id = :ser;
ROLLBACK TO SAVEPOINT t7;

\echo ''
\echo '=== TEST 8: a walk-in joining at 22:45. MUST SUCCEED ==='
SAVEPOINT t8;
INSERT INTO walk_in_entry (id, branch_id, trading_day, guest_name, service_ids,
                           duration_min, joined_min, updated_at)
VALUES (gen_random_uuid(), :branch, '2026-10-07', 'Sara', ARRAY['blow-dry'],
        45, 1365, now())
RETURNING joined_min AS t8_joined_min;
ROLLBACK TO SAVEPOINT t8;

\echo ''
\echo '=== TEST 9: a walk-in joining at 24:00. MUST FAIL (walk_in_joined_inside_clock_day) ==='
SAVEPOINT t9;
INSERT INTO walk_in_entry (id, branch_id, trading_day, guest_name, service_ids,
                           duration_min, joined_min, updated_at)
VALUES (gen_random_uuid(), :branch, '2026-10-07', 'Sara', ARRAY['blow-dry'],
        45, 1440, now());
ROLLBACK TO SAVEPOINT t9;

\echo ''
\echo '=== TEST 10: the old names are gone and the new ones guard (expect 3 rows, all new) ==='
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname IN ('series_start_inside_trading_day',
                   'occurrence_start_inside_trading_day',
                   'walk_in_joined_inside_trading_day',
                   'series_start_inside_clock_day',
                   'occurrence_start_inside_clock_day',
                   'walk_in_joined_inside_clock_day')
 ORDER BY conname;

\echo ''
\echo '=== CLEANUP: roll back; nothing is left behind ==='
ROLLBACK;
