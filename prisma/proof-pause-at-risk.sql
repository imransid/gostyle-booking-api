-- ============================================================================
-- PROOF: pausing a series that has a NEEDS_ATTENTION occurrence.
--
-- THE BUG. `POST /v1/bookings/series-admin/{id}/pause` answered
--
--     500 {"code":"BOOKING_STATE_INVALID","message":"Something went wrong."}
--
-- on a series whose health was AT_RISK with five NEEDS_ATTENTION occurrences,
-- and 201 on a healthy one. Reproducible three times out of three. So pausing
-- worked on every series nobody needs to pause, and failed on exactly the ones
-- a desk reaches for.
--
-- THE CAUSE. `occurrence_alternatives_only_when_stuck` holds
--
--     alternatives IS NULL OR state = 'needs_attention'
--
-- A stuck occurrence carries the three nearest alternatives the repair ladder
-- found. `cancelOccurrences` moved it to 'skipped' and left them behind, the
-- CHECK fired, the whole transaction aborted, and the client got a bare 500.
--
-- The constraint was right. A stale ladder on a visit that is never going to
-- happen is a list of slots nobody will take.
--
-- WHAT THIS SCRIPT DOES. Seeds the exact shape -- one materialised occurrence
-- and one needs-attention occurrence with alternatives -- then runs the OLD
-- write and the NEW write against it. TEST 1 must fail. TEST 2 must succeed.
-- A silent success on TEST 1 means the constraint is gone and this proves
-- nothing.
--
-- Run:
--   psql "$DATABASE_URL" -f prisma/proof-pause-at-risk.sql
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- ---------------------------------------------------------------- the seed

INSERT INTO booking_series (
  id, branch_id, customer_id, anchor_day, start_min,
  pattern, weekdays, interval_weeks, day_of_month, custom_dates,
  end_kind, end_count, auto_confirm_rule, service_id,
  baseline_price_fils, status, updated_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  DATE '2026-10-06', 1080,
  'weekly', ARRAY[2], NULL, NULL, ARRAY[]::date[],
  'after_count', 6, 'ask_each_time',
  '44444444-4444-4444-8444-444444444444',
  12000, 'active', now()
);

-- A planned visit the engine could not seat, WITH the ladder attached. This
-- is what the materialiser writes on rung 4, and it is legal.
INSERT INTO series_occurrence (
  id, series_id, index, planned_day, planned_start_min, state, alternatives,
  updated_at
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  0, DATE '2026-10-06', 1080, 'needs_attention',
  '[{"startMin":1155,"staffId":"maya","distanceMin":75},
    {"startMin":900,"staffId":"reem","distanceMin":180}]'::jsonb,
  now()
);

-- And an ordinary planned one, so the pause has something it CAN release.
INSERT INTO series_occurrence (
  id, series_id, index, planned_day, planned_start_min, state, updated_at
) VALUES (
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  1, DATE '2026-10-13', 1080, 'planned', now()
);

SELECT index, state, (alternatives IS NOT NULL) AS has_ladder
  FROM series_occurrence
 WHERE series_id = '11111111-1111-4111-8111-111111111111'
 ORDER BY index;

-- ------------------------------------------------ TEST 1: MUST FAIL
-- The write cancelOccurrences used to make. State moves, ladder stays.

\echo ''
\echo '=== TEST 1: skip a needs_attention occurrence and KEEP its alternatives -- MUST FAIL ==='

SAVEPOINT before_test_1;

UPDATE series_occurrence
   SET state = 'skipped', booking_id = NULL
 WHERE id = '55555555-5555-4555-8555-555555555555';

ROLLBACK TO SAVEPOINT before_test_1;

-- ------------------------------------------------ TEST 2: MUST SUCCEED
-- The write it makes now. The ladder goes with the state.

\echo ''
\echo '=== TEST 2: skip it and clear the alternatives -- MUST SUCCEED ==='

UPDATE series_occurrence
   SET state = 'skipped', booking_id = NULL, alternatives = NULL
 WHERE id = '55555555-5555-4555-8555-555555555555';

SELECT index, state, (alternatives IS NOT NULL) AS has_ladder
  FROM series_occurrence
 WHERE series_id = '11111111-1111-4111-8111-111111111111'
 ORDER BY index;

-- ------------------------------------------------ TEST 3: MUST FAIL
-- detachOccurrence had the identical hole: THIS_OCCURRENCE on a stuck visit.

\echo ''
\echo '=== TEST 3: detach a needs_attention occurrence, ladder kept -- MUST FAIL ==='

SAVEPOINT before_test_3;

UPDATE series_occurrence
   SET state = 'needs_attention', alternatives =
     '[{"startMin":1155,"staffId":"maya","distanceMin":75}]'::jsonb
 WHERE id = '55555555-5555-4555-8555-555555555555';

UPDATE series_occurrence
   SET state = 'detached'
 WHERE id = '55555555-5555-4555-8555-555555555555';

ROLLBACK TO SAVEPOINT before_test_3;

-- ------------------------------------------------ TEST 4: MUST SUCCEED

\echo ''
\echo '=== TEST 4: detach it and clear the alternatives -- MUST SUCCEED ==='

UPDATE series_occurrence
   SET state = 'needs_attention', alternatives =
     '[{"startMin":1155,"staffId":"maya","distanceMin":75}]'::jsonb
 WHERE id = '55555555-5555-4555-8555-555555555555';

UPDATE series_occurrence
   SET state = 'detached', alternatives = NULL
 WHERE id = '55555555-5555-4555-8555-555555555555';

SELECT index, state, (alternatives IS NOT NULL) AS has_ladder
  FROM series_occurrence
 WHERE series_id = '11111111-1111-4111-8111-111111111111'
 ORDER BY index;

ROLLBACK;

\echo ''
\echo 'Expected: TEST 1 and TEST 3 print occurrence_alternatives_only_when_stuck.'
\echo 'A silent success on either means the CHECK is gone and this proved nothing.'
