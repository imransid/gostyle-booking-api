-- Live proof of a mobile routine (POST /v1/mobile-booking/series).
--
-- Run it against a routine the API has just created, never a seeded one:
-- the point is to see what the running code actually wrote.
--
--   psql "$DATABASE_URL" -v sid="'<routine id from the 201>'" -f prisma/proof-mobile-series-created.sql
--
-- The CHECKs print what is stored. CHECK 4 is the desk nightly job's own
-- question, asked for every day of the next ten years. Every TEST is a write
-- that MUST FAIL, inside a transaction that is rolled back, so nothing is
-- left behind (CLAUDE.md 5).

\set ON_ERROR_STOP off
\pset pager off

\echo ''
\echo '=== CHECK 1: one series row, desk-shaped, with the mobile columns ==='
SELECT id, status, source, pattern, end_kind, end_count, anchor_day,
       custom_dates, start_min, auto_confirm_rule, frequency,
       cardinality(service_ids) AS services, payment_plan,
       materialised_through, preferred_staff_id IS NOT NULL AS has_stylist
  FROM booking_series WHERE id = :sid;

\echo ''
\echo '=== CHECK 2: one occurrence per session and its booking: confirmed, paid at the salon, linked, recurring ==='
SELECT o.index, o.planned_day, o.planned_start_min, o.state,
       b.code, b.status, b.payment_status, b.channel, b.booking_type,
       b.series_id = o.series_id AS linked,
       b.link_expires_at IS NULL AS no_payment_window
  FROM series_occurrence o
  LEFT JOIN booking b ON b.id = o.booking_id
 WHERE o.series_id = :sid
 ORDER BY o.index;

\echo ''
\echo '=== CHECK 3: the two links agree (both counts must be 0) ==='
SELECT
  (SELECT count(*) FROM booking b
    WHERE b.series_id = :sid
      AND NOT EXISTS (SELECT 1 FROM series_occurrence o
                       WHERE o.series_id = :sid AND o.booking_id = b.id))
    AS bookings_no_occurrence_holds,
  (SELECT count(*) FROM series_occurrence o
     JOIN booking b ON b.id = o.booking_id
    WHERE o.series_id = :sid
      AND (b.series_id IS DISTINCT FROM :sid OR b.booking_type <> 'routine'))
    AS occurrences_not_pointed_back;

\echo ''
\echo '=== CHECK 4: THE DESK NIGHTLY JOB never picks it (days_picked must be 0) ==='
-- SeriesRepository.dueForTopUp, word for word in SQL: status active, and
-- materialised_through null or before today. Asked for every day from today
-- for ten years, and for the last day Postgres has.
SELECT count(*) AS days_checked,
       count(*) FILTER (
         WHERE s.status = 'active'
           AND (s.materialised_through IS NULL
                OR s.materialised_through < d::date)
       ) AS days_picked
  FROM booking_series s,
       generate_series(current_date, current_date + 3650, interval '1 day') d
 WHERE s.id = :sid;
SELECT count(*) AS picked_on_9999_12_31
  FROM booking_series s
 WHERE s.id = :sid AND s.status = 'active'
   AND (s.materialised_through IS NULL OR s.materialised_through < DATE '9999-12-31');

\echo ''
\echo '=== CHECK 5: the desk board reads it (the seriesBoard aggregate, for this id) ==='
SELECT s.id, s.status::text AS status, s.pattern::text AS pattern,
       s.end_kind::text AS end_kind, s.end_count, s.baseline_price_fils,
       count(o.*) FILTER (WHERE o.state = 'needs_attention') AS needs_attention,
       count(o.*) FILTER (WHERE o.state = 'skipped') AS skipped,
       count(o.*) AS total_occurrences,
       min(o.planned_day) FILTER (
         WHERE o.planned_day >= CURRENT_DATE AND o.state <> 'skipped'
       ) AS next_day
  FROM booking_series s
  LEFT JOIN series_occurrence o ON o.series_id = s.id
 WHERE s.id = :sid
 GROUP BY s.id;

\echo ''
\echo '=== CHECK 6: the event, same commit as the rows ==='
SELECT event_type, payload
  FROM event_outbox
 WHERE aggregate_type = 'series' AND aggregate_id = :sid;

BEGIN;

\echo ''
\echo '=== TEST 1: a second occurrence on an already linked booking. MUST FAIL (booking_id unique) ==='
SAVEPOINT t1;
INSERT INTO series_occurrence (id, series_id, index, planned_day, planned_start_min, state, booking_id, updated_at)
SELECT gen_random_uuid(), :sid, 99, o.planned_day, o.planned_start_min, 'materialised', o.booking_id, now()
  FROM series_occurrence o
 WHERE o.series_id = :sid AND o.booking_id IS NOT NULL
 LIMIT 1;
ROLLBACK TO SAVEPOINT t1;

\echo ''
\echo '=== TEST 2: a booked session losing its booking. MUST FAIL (occurrence_booking_matches_state) ==='
SAVEPOINT t2;
UPDATE series_occurrence SET booking_id = NULL
 WHERE series_id = :sid AND state = 'materialised';
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '=== TEST 3: the routine losing its services. MUST FAIL (series_mobile_has_services) ==='
SAVEPOINT t3;
UPDATE booking_series SET service_ids = '{}' WHERE id = :sid;
ROLLBACK TO SAVEPOINT t3;

\echo ''
\echo '=== TEST 4: a session at 09:00. MUST FAIL (occurrence_start_inside_trading_day) ==='
SAVEPOINT t4;
UPDATE series_occurrence SET planned_start_min = 540 WHERE series_id = :sid;
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== CLEANUP: roll back; the routine is untouched ==='
ROLLBACK;

SELECT count(*) AS sessions_still_booked
  FROM series_occurrence o
  JOIN booking b ON b.id = o.booking_id
 WHERE o.series_id = :sid AND b.status = 'confirmed';
