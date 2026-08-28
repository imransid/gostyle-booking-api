\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set maya    '''22222222-2222-2222-2222-222222222222'''
\set svc     '''77777777-7777-7777-7777-777777777777'''
\set ser     '''cccccccc-0000-0000-0000-000000000001'''

\echo ''
\echo '=== SETUP: Dana every Tuesday and Thursday at 18:00, open-ended ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, preferred_staff_id, baseline_price_fils,
                            updated_at)
VALUES (:ser, :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2,4]::smallint[], 'never', 'auto_confirm_on_schedule',
        :svc, :maya, 18000, now());
\echo '--> series created'

\echo ''
\echo '=== TEST 1: a weekly series with NO weekdays. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule,
                            service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[]::smallint[], 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 1b: custom pattern with an EMPTY date list. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, custom_dates, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'custom', ARRAY[]::date[], 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 1c: monthly_on_date with a NULL day_of_month. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'monthly_on_date', 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 2: every_n_weeks with no interval. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'every_n_weeks', 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 3: weekday 8. There is no eighth day. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2,8]::smallint[], 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 4: monthly on the 32nd. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, day_of_month, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'monthly_on_date', 32, 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 5: end_kind never, but carrying an end_count. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, end_count,
                            auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'never', 10, 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 6: end_kind after_count with a count of ZERO. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, end_count,
                            auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'after_count', 0, 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 7: a series ending BEFORE it starts. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, end_date,
                            auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'on_date', '2026-08-01', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 8: a start at 03:00, outside the trading day. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule, service_id, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 180,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, now());

\echo ''
\echo '=== TEST 9: a course with visits but no money. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule, service_id,
                            course_visits, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, 6, now());

\echo ''
\echo '=== TEST 10: drawing a 7th visit from a 6-visit course. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule, service_id,
                            course_total_net_fils, course_visits, course_drawn, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc,
        180000, 6, 7, now());

\echo ''
\echo '=== TEST 11: course_drawn on a series with NO course. MUST FAIL. ==='
INSERT INTO booking_series (id, branch_id, customer_id, anchor_day, start_min,
                            pattern, weekdays, end_kind, auto_confirm_rule, service_id,
                            course_drawn, updated_at)
VALUES (gen_random_uuid(), :branch, :dana, '2026-09-01', 1080,
        'weekly', ARRAY[2]::smallint[], 'never', 'ask_each_time', :svc, 3, now());

\echo ''
\echo '=== SETUP: a planned occurrence, the twelfth of the series ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, updated_at)
VALUES ('dddddddd-0000-0000-0000-000000000001', :ser, 11, '2026-11-03', 1080, 'planned', now());
\echo '--> occurrence created'

\echo ''
\echo '=== TEST 12: a SECOND occurrence with the same ordinal. MUST FAIL. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, updated_at)
VALUES (gen_random_uuid(), :ser, 11, '2026-11-10', 1080, 'planned', now());

\echo ''
\echo '=== TEST 13: materialised, but carrying NO booking. MUST FAIL. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, updated_at)
VALUES (gen_random_uuid(), :ser, 12, '2026-11-10', 1080, 'materialised', now());

\echo ''
\echo '=== TEST 14: needs_attention WITH a booking. MUST FAIL. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min,
                               state, booking_id, updated_at)
VALUES (gen_random_uuid(), :ser, 13, '2026-11-10', 1080,
        'needs_attention', gen_random_uuid(), now());

\echo ''
\echo '=== TEST 15: alternatives on a PLANNED occurrence. MUST FAIL. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min,
                               state, alternatives, updated_at)
VALUES (gen_random_uuid(), :ser, 14, '2026-11-10', 1080,
        'planned', '[{"startMin":1095}]'::jsonb, now());

\echo ''
\echo '=== TEST 16: a negative ordinal. MUST FAIL. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, updated_at)
VALUES (gen_random_uuid(), :ser, -1, '2026-11-10', 1080, 'planned', now());

\echo ''
\echo '=== TEST 17: needs_attention WITH alternatives. MUST SUCCEED. ==='
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min,
                               state, alternatives, updated_at)
VALUES ('dddddddd-0000-0000-0000-000000000002', :ser, 15, '2026-11-17', 1080,
        'needs_attention', '[{"startMin":1095,"staffId":"anya"}]'::jsonb, now());
\echo '--> accepted, as it should be'

\echo ''
\echo '=== TEST 18: deleting the series CASCADES to its occurrences ==='
DELETE FROM booking_series WHERE id = :ser;
SELECT count(*) AS orphaned_occurrences FROM series_occurrence WHERE series_id = :ser;

\echo ''
\echo '=== The partial indexes exist ==='
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('series_materialise_idx','occurrence_needs_attention_idx','occurrence_booking_idx')
 ORDER BY indexname;
