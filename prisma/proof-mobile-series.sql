-- Live proof of the mobile routine migration (20260926120000_mobile_series).
--
--   psql "$DATABASE_URL" -f prisma/proof-mobile-series.sql
--
-- EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. The
-- migration is applied twice (it must be re-runnable, CLAUDE.md 3), rows are
-- seeded, the tests run, and the ROLLBACK at the end removes all of it. On a
-- database where the migration is already applied, the two runs are no-ops,
-- which is the point.
--
-- Every TEST is a write that MUST FAIL: the expected errors print in order,
-- and a silent success shows up as a missing error (CLAUDE.md 5). Every WORK
-- is a write the desk does today and MUST STILL SUCCEED on a mobile routine.
-- Each write runs in its own savepoint, so one failure does not abort the rest.

\set ON_ERROR_STOP off
\pset pager off

BEGIN;

\echo ''
\echo '=== STEP 1: the migration, run twice. Both runs must be silent ==='
\ir migrations/20260926120000_mobile_series/migration.sql
\ir migrations/20260926120000_mobile_series/migration.sql

\echo ''
\echo '=== CHECK 1: eight new columns, all nullable, none with a default ==='
SELECT column_name, data_type, udt_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'booking_series'
   AND column_name IN ('source', 'frequency', 'service_ids', 'payment_plan',
                       'paused_until', 'pause_reason', 'pause_note',
                       'miss_streak_after')
 ORDER BY column_name;

\echo ''
\echo '=== CHECK 2: six new constraints, each once (the second run added none) ==='
SELECT conname, count(*) AS times
  FROM pg_constraint
 WHERE conrelid = 'booking_series'::regclass
   AND conname IN ('series_source_known', 'series_frequency_known',
                   'series_mobile_has_services', 'series_payment_plan_known',
                   'series_pause_reason_known', 'series_pause_note_length')
 GROUP BY conname
 ORDER BY conname;

\echo ''
\echo '=== SETUP 1: a desk series, written exactly as the desk writes it (no new column named). MUST WORK ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, end_count,
                            auto_confirm_rule, service_id, updated_at)
VALUES ('5e1e5000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(),
        current_date + 7, 1080, 'weekly', ARRAY[2]::smallint[], 'after_count', 6,
        'auto_confirm_on_schedule', gen_random_uuid(), now());

\echo ''
\echo '=== SETUP 2: a desk series with an EMPTY service_ids list, in case Prisma ever sends one. MUST WORK ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, service_ids, updated_at)
VALUES ('5e1e5000-0000-4000-8000-000000000002', gen_random_uuid(), gen_random_uuid(),
        current_date + 7, 1080, 'weekly', ARRAY[4]::smallint[], 'never',
        'auto_confirm_on_schedule', gen_random_uuid(), '{}', now());

\echo ''
\echo '=== SETUP 3: a mobile routine, the shape the mobile create will write. MUST WORK ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, custom_dates, end_kind, end_count,
                            auto_confirm_rule, service_id, updated_at,
                            source, frequency, service_ids, payment_plan,
                            materialised_through)
VALUES ('5e1e5000-0000-4000-8000-000000000003', gen_random_uuid(), gen_random_uuid(),
        current_date + 3, 1080, 'custom',
        ARRAY[current_date + 3, current_date + 10, current_date + 17]::date[],
        'after_count', 3, 'auto_confirm_on_schedule',
        'aaaaaaaa-0000-4000-8000-000000000001', now(),
        'mobile', 'weekly',
        ARRAY['aaaaaaaa-0000-4000-8000-000000000001',
              'aaaaaaaa-0000-4000-8000-000000000002']::uuid[],
        'pay_at_salon', DATE '9999-12-31');

\echo ''
\echo '=== CHECK 3: what is stored (three rows) ==='
SELECT id, pattern, status, source, frequency,
       coalesce(array_length(service_ids, 1), 0) AS services,
       payment_plan, paused_until, pause_reason, miss_streak_after
  FROM booking_series
 WHERE id::text LIKE '5e1e5000-%'
 ORDER BY id;

\echo ''
\echo '=== TEST 1: a maker of series nobody declared. MUST FAIL (series_source_known) ==='
SAVEPOINT t1;
UPDATE booking_series SET source = 'kiosk'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t1;

\echo ''
\echo '=== TEST 2: a frequency the app does not offer. MUST FAIL (series_frequency_known) ==='
SAVEPOINT t2;
UPDATE booking_series SET frequency = 'yearly'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '=== TEST 3: a payment plan nobody sells. MUST FAIL (series_payment_plan_known) ==='
SAVEPOINT t3;
UPDATE booking_series SET payment_plan = 'crypto'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t3;

\echo ''
\echo '=== TEST 4: a pause reason nobody reads. MUST FAIL (series_pause_reason_known) ==='
SAVEPOINT t4;
UPDATE booking_series SET pause_reason = 'bored'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== WORK 0: each of the Figma five reasons, busy included, and missed_twice. MUST WORK (6 x UPDATE 1) ==='
SAVEPOINT w0;
UPDATE booking_series SET pause_reason = 'travel'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET pause_reason = 'health'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET pause_reason = 'busy'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET pause_reason = 'budget'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET pause_reason = 'other'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET pause_reason = 'missed_twice'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT w0;

\echo ''
\echo '=== TEST 5: a pause note of 201 characters. MUST FAIL (series_pause_note_length) ==='
SAVEPOINT t5;
UPDATE booking_series SET pause_note = repeat('x', 201)
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t5;

\echo ''
\echo '=== TEST 6: an empty pause note (send none instead). MUST FAIL (series_pause_note_length) ==='
SAVEPOINT t6;
UPDATE booking_series SET pause_note = ''
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t6;

\echo ''
\echo '=== TEST 7: a mobile routine with no service list. MUST FAIL (series_mobile_has_services) ==='
SAVEPOINT t7;
UPDATE booking_series SET service_ids = NULL
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t7;

\echo ''
\echo '=== TEST 8: a mobile routine with an empty service list. MUST FAIL (series_mobile_has_services) ==='
SAVEPOINT t8;
UPDATE booking_series SET service_ids = '{}'
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
ROLLBACK TO SAVEPOINT t8;

\echo ''
\echo '=== TEST 9: marking the empty-list desk series as mobile. MUST FAIL (series_mobile_has_services) ==='
SAVEPOINT t9;
UPDATE booking_series SET source = 'mobile'
 WHERE id = '5e1e5000-0000-4000-8000-000000000002';
ROLLBACK TO SAVEPOINT t9;

\echo ''
\echo '=== WORK 1: the app pauses the routine until a date, with a reason and a note. MUST WORK ==='
UPDATE booking_series
   SET status = 'paused', paused_until = current_date + 30,
       pause_reason = 'busy', pause_note = 'Busy at work', updated_at = now()
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== WORK 2: the DESK resumes it with its own update (status only). MUST WORK ==='
-- The desk's resume (series.repository setStatus) knows none of the new
-- columns. A CHECK tying paused_until to status = paused would fail here.
UPDATE booking_series SET status = 'active', updated_at = now()
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== CHECK 4: after the desk resume: active, and paused_until is still there (the mobile read ignores it) ==='
SELECT id, status, paused_until, pause_reason, pause_note
  FROM booking_series
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== WORK 3: the desk pauses and ends it the same way. MUST WORK ==='
UPDATE booking_series SET status = 'paused', updated_at = now()
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';
UPDATE booking_series SET status = 'ended', updated_at = now()
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== WORK 4: the server pauses for two misses (D5). MUST WORK ==='
UPDATE booking_series
   SET status = 'paused', paused_until = NULL, pause_reason = 'missed_twice',
       pause_note = NULL, miss_streak_after = current_date - 1, updated_at = now()
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== CHECK 5: paused for two misses, no resume date, the streak starts again after yesterday ==='
SELECT id, status, paused_until, pause_reason, pause_note, miss_streak_after
  FROM booking_series
 WHERE id = '5e1e5000-0000-4000-8000-000000000003';

\echo ''
\echo '=== CLEANUP: roll everything back, the migration included ==='
ROLLBACK;

SELECT count(*) AS proof_rows_left
  FROM booking_series WHERE id::text LIKE '5e1e5000-%';
