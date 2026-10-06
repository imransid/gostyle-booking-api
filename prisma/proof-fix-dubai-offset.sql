-- Live proof of prisma/fix-dubai-offset.sql (CLAUDE.md 5).
--
--   psql "$DATABASE_URL" -f prisma/proof-fix-dubai-offset.sql
--
-- EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Bookings are
-- seeded on a branch no real data uses, some at the Dubai-era +04:00 and some
-- at the correct +06:00, the fix runs, and each TEST says what MUST happen. A
-- MUST FAIL prints its error in order; a silent success shows up as a missing
-- error. Every CHECK prints the state the test left behind.
--
-- The fix is global, so it also moves any +04:00 rows already in this
-- database -- inside the same rolled-back transaction. The CHECKs read only
-- the seeded branch.

\set ON_ERROR_STOP off
\pset footer off
BEGIN;

SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date + 10 AS d,
       (now() AT TIME ZONE 'Asia/Dhaka')::date - 3  AS past \gset

-- A wall-clock minute on a day, stored at a given offset (minutes east of UTC).
CREATE FUNCTION pg_temp.at(p_day date, p_min int, p_offset int) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((p_day + make_interval(mins => p_min)) - make_interval(mins => p_offset)) AT TIME ZONE 'UTC'
$$;

-- One booking, one item and one staff reservation per segment
-- ({"staff", "start", "dur"}), all at p_offset, the way the desk wrote them.
-- A terminal booking's reservations do not block (lifecycle.repository.ts).
CREATE FUNCTION pg_temp.seed(p_code text, p_status text, p_day date, p_offset int,
                             p_segments jsonb, p_chair uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  branch constant uuid := 'f0f0f0f0-0000-4000-8000-000000000001';
  bid uuid := gen_random_uuid();
  iid uuid;
  s jsonb;
  pos int := 0;
  b_start int;
  b_end int;
  live boolean := p_status NOT IN ('settled', 'cancelled', 'no_show', 'rescheduled', 'expired', 'skipped');
BEGIN
  SELECT min((x->>'start')::int), max((x->>'start')::int + (x->>'dur')::int)
    INTO b_start, b_end FROM jsonb_array_elements(p_segments) x;
  INSERT INTO booking (id, code, branch_id, customer_id, status, trading_day, start_at, end_at,
                       start_minute, duration_min, channel, updated_at)
  VALUES (bid, p_code, branch, gen_random_uuid(), p_status::booking_status, p_day,
          pg_temp.at(p_day, b_start, p_offset), pg_temp.at(p_day, b_end, p_offset),
          b_start, b_end - b_start, 'desk', now());
  FOR s IN SELECT * FROM jsonb_array_elements(p_segments) LOOP
    iid := gen_random_uuid();
    INSERT INTO booking_item (id, booking_id, service_id, service_name, resource_type,
                              required_skill, price_fils, duration_min, position, staff_id)
    VALUES (iid, bid, gen_random_uuid(), 'Proof service', 'chair', 'cut', 0,
            (s->>'dur')::int, pos, (s->>'staff')::uuid);
    INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                                   start_at, end_at, start_minute, duration_min, blocking)
    VALUES (gen_random_uuid(), iid, branch, (s->>'staff')::uuid, p_day, 'active',
            pg_temp.at(p_day, (s->>'start')::int, p_offset),
            pg_temp.at(p_day, (s->>'start')::int + (s->>'dur')::int, p_offset),
            (s->>'start')::int, (s->>'dur')::int, live);
    IF pos = 0 AND p_chair IS NOT NULL THEN
      INSERT INTO resource_reservation (id, booking_item_id, branch_id, resource_type, resource_unit_id,
                                        trading_day, start_at, end_at, start_minute, duration_min, blocking)
      VALUES (gen_random_uuid(), iid, branch, 'chair', p_chair, p_day,
              pg_temp.at(p_day, (s->>'start')::int, p_offset),
              pg_temp.at(p_day, (s->>'start')::int + (s->>'dur')::int, p_offset),
              (s->>'start')::int, (s->>'dur')::int, live);
    END IF;
    pos := pos + 1;
  END LOOP;
END
$$;

-- What every CHECK prints: each seeded booking, its stored offset, and its
-- reservations' offsets and blocking flags.
CREATE FUNCTION pg_temp.state() RETURNS TABLE (code text, status text, booking_offset text, reservations text)
LANGUAGE sql AS $$
  SELECT b.code, b.status::text,
         to_char(make_interval(mins => round(extract(epoch FROM (b.trading_day + make_interval(mins => b.start_minute))
                                                     - (b.start_at AT TIME ZONE 'UTC')) / 60)::int), '+HH24:MI'),
         (SELECT string_agg(format('%s %s%s', k, to_char(make_interval(mins => off), '+HH24:MI'),
                                   CASE WHEN blk THEN ' blocking' ELSE '' END), ', ' ORDER BY k, off)
            FROM (SELECT 'staff' k, r.blocking blk,
                         round(extract(epoch FROM (r.trading_day + make_interval(mins => r.start_minute))
                                             - (r.start_at AT TIME ZONE 'UTC')) / 60)::int off
                    FROM staff_reservation r JOIN booking_item i ON i.id = r.booking_item_id WHERE i.booking_id = b.id
                  UNION ALL
                  SELECT 'chair', r.blocking,
                         round(extract(epoch FROM (r.trading_day + make_interval(mins => r.start_minute))
                                             - (r.start_at AT TIME ZONE 'UTC')) / 60)::int
                    FROM resource_reservation r JOIN booking_item i ON i.id = r.booking_item_id WHERE i.booking_id = b.id) x)
    FROM booking b
   WHERE b.branch_id = 'f0f0f0f0-0000-4000-8000-000000000001'
   ORDER BY b.code
$$;

\echo ''
\echo '=== SETUP: one branch, four stylists, one chair ==='
\echo '    A  confirmed +04:00  10:00-11:00 Maya, on chair 1'
\echo '    B  confirmed +04:00  10:30-12:00 Noor, then 12:00-14:30 Maya   (starts before C, uses Maya after it)'
\echo '    C  confirmed +04:00  11:00-12:00 Maya'
\echo '    P  pending_payment +04:00  18:00-18:30 Noor'
\echo '    D  confirmed +04:00  15:00-16:00 Lina   } the SAME booked slot: a double booking the'
\echo '    E  confirmed +06:00  15:00-16:00 Lina   } wrong offset has hidden from the guard'
\echo '    F  cancelled +04:00  17:00-18:00 Maya   (terminal: stays)'
\echo '    G  confirmed +04:00  three days ago     (past: stays)'
\echo '    H  confirmed +06:00  16:00-17:00 Noor   (already right: untouched)'
SELECT pg_temp.seed('PROOF-A', 'confirmed', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000a","start":600,"dur":60}]', 'c0000000-0000-4000-8000-000000000001');
SELECT pg_temp.seed('PROOF-B', 'confirmed', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000b","start":630,"dur":90},{"staff":"a0000000-0000-4000-8000-00000000000a","start":720,"dur":150}]');
SELECT pg_temp.seed('PROOF-C', 'confirmed', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000a","start":660,"dur":60}]');
SELECT pg_temp.seed('PROOF-P', 'pending_payment', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000b","start":1080,"dur":30}]');
SELECT pg_temp.seed('PROOF-D', 'confirmed', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000c","start":900,"dur":60}]');
SELECT pg_temp.seed('PROOF-E', 'confirmed', :'d', 360, '[{"staff":"a0000000-0000-4000-8000-00000000000c","start":900,"dur":60}]');
SELECT pg_temp.seed('PROOF-F', 'cancelled', :'d', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000a","start":1020,"dur":60}]');
SELECT pg_temp.seed('PROOF-G', 'confirmed', :'past', 240, '[{"staff":"a0000000-0000-4000-8000-00000000000a","start":600,"dur":60}]');
SELECT pg_temp.seed('PROOF-H', 'confirmed', :'d', 360, '[{"staff":"a0000000-0000-4000-8000-00000000000b","start":960,"dur":60}]');
SELECT count(*) AS outbox_rows_before FROM event_outbox \gset
SELECT * FROM pg_temp.state();

\echo ''
\echo '=== TEST 1: the fix with D and E both live. MUST FAIL, naming PROOF-D and PROOF-E. ==='
SAVEPOINT t1;
\ir fix-dubai-offset.sql
ROLLBACK TO SAVEPOINT t1;
\echo '--- CHECK 1: all or nothing. A, B, C and P MUST still be at +04:00.'
SELECT * FROM pg_temp.state() WHERE code IN ('PROOF-A', 'PROOF-B', 'PROOF-C', 'PROOF-P');

\echo ''
\echo '=== TEST 2: resolve the clash by hand (cancel D, as the desk would), run it again. MUST SUCCEED. ==='
\echo '    4 bookings moved (confirmed 3, pending_payment 1). B moving past C is NOT a clash.'
UPDATE booking SET status = 'cancelled' WHERE code = 'PROOF-D';
UPDATE staff_reservation SET blocking = false
 WHERE booking_item_id IN (SELECT i.id FROM booking_item i JOIN booking b ON b.id = i.booking_id WHERE b.code = 'PROOF-D');
\ir fix-dubai-offset.sql
\echo '--- CHECK 2: A, B, C, P at +06:00 with every reservation +06:00 and blocking, A''s chair included.'
\echo '             D, F at +04:00 not blocking. G at +04:00 (past). E, H at +06:00 as seeded.'
SELECT * FROM pg_temp.state();
\echo '--- CHECK 3: no event written. MUST print 0.'
SELECT count(*) - :outbox_rows_before AS new_outbox_rows FROM event_outbox;

\echo ''
\echo '=== TEST 3: run it a third time. MUST MOVE NOTHING: bookings moved: 0 (none). ==='
\ir fix-dubai-offset.sql

\echo ''
\echo '=== TEST 4: the guard now covers A''s real hour: a new booking on Maya at 10:00 Dhaka. MUST FAIL. ==='
SAVEPOINT t4;
SELECT pg_temp.seed('PROOF-X', 'confirmed', :'d', 360, '[{"staff":"a0000000-0000-4000-8000-00000000000a","start":600,"dur":60}]');
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== TEST 5 (control): the same hour on a stylist with nothing booked. MUST SUCCEED. ==='
SELECT pg_temp.seed('PROOF-Y', 'confirmed', :'d', 360, '[{"staff":"a0000000-0000-4000-8000-00000000000d","start":600,"dur":60}]');

ROLLBACK;
