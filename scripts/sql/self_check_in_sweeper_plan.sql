-- Self check-in: the query plan of the auto no-show sweeper's candidate
-- query, before and after PR 1 (1547102). Changes NOTHING.
--
-- Run it against the BOOKING database (the DATABASE_URL of the
-- gostyle-booking-api service), for example:
--
--   psql "<booking DATABASE_URL without ?schema=public>" \
--        -v ON_ERROR_STOP=1 -f self_check_in_sweeper_plan.sql
--
-- and paste the whole answer back.
--
-- HOW IT STAYS HARMLESS. Production has no check_in_request table until PR 1
-- is deployed, so the script makes an EMPTY stand-in: a TEMPORARY table, with
-- the same index as the migration's. A temporary table lives only in this
-- psql session, is seen by nobody else, and is dropped by the ROLLBACK at the
-- end. Straight after creating it the transaction is switched to READ ONLY,
-- so every query on a real table below runs read-only: Postgres itself
-- refuses any write from that point. EXPLAIN ANALYZE does run the queries,
-- but they are SELECTs. Time limits stop it from waiting on anything.
--
-- Run after PR 1 is deployed, the stand-in hides the real (empty) table for
-- this session only. The answer is the same.
--
-- FOUR PLANS:
--   A  the query production runs today
--   B  the query PR 1 runs, at today's clock
--   C  A with the clock 30 days ahead
--   D  B with the clock 30 days ahead
--
-- WHY C AND D. The sweeper empties its own candidates every minute, so A and
-- B will usually find no rows, and then the NOT EXISTS never runs at all.
-- Moving the clock ahead lets both take up to 50 confirmed bookings through
-- the same index, so D shows what the NOT EXISTS costs per booking, next to C.
--
-- WHAT GOOD LOOKS LIKE:
--   * B and D use the same scan as A and C (Index Scan using
--     booking_auto_no_show_idx on a table big enough for it to pay; on a
--     small table Postgres may choose a Seq Scan for A and C too, and then
--     the same for B and D is not a regression).
--   * D's filter is NOT EXISTS(SubPlan ...), one probe per booking on
--     check_in_request_booking_idx, a few microseconds each, and D's total
--     time within a fraction of a millisecond of C's.
--
-- The two queries are copies of no-show-sweeper.service.ts, before and
-- after 1547102, with arrivalClaimed() from check-in-request.repository.ts
-- written out. The sweeper sends its cutoff as a parameter; PREPARE does
-- the same here.

\pset pager off
\timing off

\echo ''
\echo '=== CONTEXT ==='
SELECT current_database()                                   AS database,
       version()                                            AS postgres,
       to_regclass('public.check_in_request') IS NOT NULL   AS real_table_exists,
       (SELECT count(*) FROM booking)                       AS bookings,
       (SELECT count(*) FROM booking
         WHERE status = 'confirmed')                        AS confirmed,
       (SELECT count(*) FROM booking
         WHERE status = 'confirmed'
           AND start_at <= now() - interval '30 minutes')   AS due_now,
       (SELECT count(*) FROM booking
         WHERE status = 'confirmed'
           AND start_at <= now() + interval '30 days')      AS due_in_30_days;

BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';

-- The empty stand-in. Only the columns the query reads, and the index the
-- migration creates (20261008105012_self_check_in_request).
CREATE TEMPORARY TABLE check_in_request (
  id         uuid        PRIMARY KEY,
  booking_id uuid        NOT NULL,
  state      text        NOT NULL,
  raised_at  timestamptz NOT NULL
) ON COMMIT DROP;
CREATE INDEX check_in_request_booking_idx
  ON check_in_request (booking_id, raised_at DESC);

-- From here on, Postgres refuses any write.
SET TRANSACTION READ ONLY;
SHOW transaction_read_only;

PREPARE sweep_today(timestamptz) AS
  SELECT id, code
    FROM booking
   WHERE status = 'confirmed'
     AND start_at <= $1
   ORDER BY start_at
   LIMIT 50;

PREPARE sweep_pr1(timestamptz) AS
  SELECT b.id, b.code
    FROM booking b
   WHERE b.status = 'confirmed'
     AND b.start_at <= $1
     AND NOT EXISTS (
       SELECT 1
         FROM (SELECT r.state
                 FROM check_in_request r
                WHERE r.booking_id = b.id
                ORDER BY r.raised_at DESC, r.id DESC
                LIMIT 1) latest
        WHERE latest.state <> 'rejected')
   ORDER BY b.start_at
   LIMIT 50;

\echo ''
\echo '=== A: today, today''s clock ==='
EXPLAIN (ANALYZE, BUFFERS) EXECUTE sweep_today(now() - interval '30 minutes');

\echo ''
\echo '=== B: PR 1, today''s clock ==='
EXPLAIN (ANALYZE, BUFFERS) EXECUTE sweep_pr1(now() - interval '30 minutes');

\echo ''
\echo '=== C: today, clock 30 days ahead (rows to look at) ==='
EXPLAIN (ANALYZE, BUFFERS) EXECUTE sweep_today(now() + interval '30 days');

\echo ''
\echo '=== D: PR 1, clock 30 days ahead (the NOT EXISTS runs once per row) ==='
EXPLAIN (ANALYZE, BUFFERS) EXECUTE sweep_pr1(now() + interval '30 days');

ROLLBACK;
DEALLOCATE ALL;

\echo ''
\echo '=== DONE: rolled back; the stand-in is gone ==='
SELECT to_regclass('pg_temp.check_in_request') IS NULL AS stand_in_gone;
