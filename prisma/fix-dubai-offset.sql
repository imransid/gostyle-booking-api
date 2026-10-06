-- One-off data fix: the bookings the Dubai-era code stored at +04:00.
--
-- Until b723088 (2026-09-18) start_at and end_at were derived from the booked
-- wall clock (trading_day + start_minute) at a hard-coded +04:00. Every branch
-- is in Asia/Dhaka (+06:00, platform's branch.timezone), so those instants are
-- two hours late: the double-booking guard (the tstzrange EXCLUDE on the
-- reservations) protects the wrong two hours, and the reminder ladder fires two
-- hours late. The WALL CLOCK IS THE TRUTH: desk holds took day + startMin, and
-- that is the time staff and customers were given.
--
-- WHAT MOVES: every booking still at +04:00 that is not terminal and whose
-- booked Dhaka time is still ahead, with its staff and resource reservations,
-- by exactly -2 hours. Nothing else changes: not the wall clock, status, money,
-- reminder stamps or the outbox. NO EVENT IS WRITTEN: nothing changed for the
-- customer, and a booking.moved event would push every one of them "your
-- booking was moved". The terminal list is TERMINAL_STATES in
-- domain/booking/lifecycle.ts; their reservations no longer block.
--
-- WHY THREE STEPS. The guard is a non-deferrable EXCLUDE, checked row by row.
-- Moving rows one at a time can collide with a booking that is itself about to
-- move -- a booking can start earlier than another and still use the same
-- stylist later in its sequence -- so: release the target reservations, move
-- everything, then re-block them one row at a time. Each re-block is checked
-- against final positions only, so the only thing that can fail it is a real
-- double booking.
--
-- ALL OR NOTHING. Every real clash is listed, then the run raises and nothing
-- is changed. Resolve those bookings by hand and run it again.
--
-- RE-RUNNABLE: it selects by the stored offset, so a second run moves nothing.
--
-- Run inside a transaction the caller owns; ROLLBACK is the dry run:
--   BEGIN;  <this file>;  ROLLBACK;   -- or COMMIT
-- Proven by prisma/proof-fix-dubai-offset.sql (CLAUDE.md 5).

DROP TABLE IF EXISTS fix_target, fix_staff, fix_resource;

CREATE TEMP TABLE fix_target ON COMMIT DROP AS
  SELECT id, code, status::text AS status
    FROM booking
   WHERE round(extract(epoch FROM (trading_day + make_interval(mins => start_minute))
                                - (start_at AT TIME ZONE 'UTC')) / 60) = 240
     AND status NOT IN ('settled', 'cancelled', 'no_show', 'rescheduled', 'expired', 'skipped')
     AND (trading_day + make_interval(mins => start_minute)) AT TIME ZONE 'Asia/Dhaka' > now();

-- A reservation moves only when it is itself at +04:00. One rewritten since
-- (a move after b723088 rewrites both) is already right and is left alone.
CREATE TEMP TABLE fix_staff ON COMMIT DROP AS
  SELECT r.id, r.blocking, t.code
    FROM staff_reservation r
    JOIN booking_item i ON i.id = r.booking_item_id
    JOIN fix_target t ON t.id = i.booking_id
   WHERE round(extract(epoch FROM (r.trading_day + make_interval(mins => r.start_minute))
                                - (r.start_at AT TIME ZONE 'UTC')) / 60) = 240;

CREATE TEMP TABLE fix_resource ON COMMIT DROP AS
  SELECT r.id, r.blocking, t.code
    FROM resource_reservation r
    JOIN booking_item i ON i.id = r.booking_item_id
    JOIN fix_target t ON t.id = i.booking_id
   WHERE round(extract(epoch FROM (r.trading_day + make_interval(mins => r.start_minute))
                                - (r.start_at AT TIME ZONE 'UTC')) / 60) = 240;

DO $fix$
DECLARE
  rec record;
  other text;
  clashes text[] := '{}';
  reblocked int := 0;
  left_alone int;
  left_behind int;
BEGIN
  SELECT count(*) INTO left_alone
    FROM staff_reservation r
    JOIN booking_item i ON i.id = r.booking_item_id
    JOIN fix_target t ON t.id = i.booking_id
   WHERE r.id NOT IN (SELECT id FROM fix_staff);

  -- 1. Release. Nothing about the target can trip the guard while it moves.
  UPDATE staff_reservation SET blocking = false WHERE id IN (SELECT id FROM fix_staff WHERE blocking);
  UPDATE resource_reservation SET blocking = false WHERE id IN (SELECT id FROM fix_resource WHERE blocking);

  -- 2. Move. Same two hours everywhere, so every duration and gap is kept.
  UPDATE booking
     SET start_at = start_at - interval '2 hours', end_at = end_at - interval '2 hours'
   WHERE id IN (SELECT id FROM fix_target);
  UPDATE staff_reservation
     SET start_at = start_at - interval '2 hours', end_at = end_at - interval '2 hours'
   WHERE id IN (SELECT id FROM fix_staff);
  UPDATE resource_reservation
     SET start_at = start_at - interval '2 hours', end_at = end_at - interval '2 hours'
   WHERE id IN (SELECT id FROM fix_resource);

  -- 3. Re-block, one row at a time, each in its own subtransaction, so every
  -- clash is found rather than only the first.
  FOR rec IN SELECT 'staff' AS kind, id, code FROM fix_staff WHERE blocking
           UNION ALL
           SELECT 'resource', id, code FROM fix_resource WHERE blocking
  LOOP
    BEGIN
      IF rec.kind = 'staff' THEN
        UPDATE staff_reservation SET blocking = true WHERE id = rec.id;
      ELSE
        UPDATE resource_reservation SET blocking = true WHERE id = rec.id;
      END IF;
      reblocked := reblocked + 1;
    EXCEPTION WHEN exclusion_violation THEN
      IF rec.kind = 'staff' THEN
        SELECT string_agg(DISTINCT coalesce(b2.code, 'a hold'), ', ') INTO other
          FROM staff_reservation me
          JOIN staff_reservation o
            ON o.staff_id = me.staff_id AND o.blocking AND o.id <> me.id
           AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(me.start_at, me.end_at, '[)')
          LEFT JOIN booking_item i2 ON i2.id = o.booking_item_id
          LEFT JOIN booking b2 ON b2.id = i2.booking_id
         WHERE me.id = rec.id;
        clashes := clashes || (SELECT format('%s on staff %s at %s %s collides with %s',
                     rec.code, left(me.staff_id::text, 8), me.trading_day,
                     to_char(make_interval(mins => me.start_minute), 'HH24:MI'), other)
                     FROM staff_reservation me WHERE me.id = rec.id);
      ELSE
        SELECT string_agg(DISTINCT coalesce(b2.code, 'a hold'), ', ') INTO other
          FROM resource_reservation me
          JOIN resource_reservation o
            ON o.resource_unit_id = me.resource_unit_id AND o.blocking AND o.id <> me.id
           AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(me.start_at, me.end_at, '[)')
          LEFT JOIN booking_item i2 ON i2.id = o.booking_item_id
          LEFT JOIN booking b2 ON b2.id = i2.booking_id
         WHERE me.id = rec.id;
        clashes := clashes || (SELECT format('%s on chair %s at %s %s collides with %s',
                     rec.code, left(me.resource_unit_id::text, 8), me.trading_day,
                     to_char(make_interval(mins => me.start_minute), 'HH24:MI'), other)
                     FROM resource_reservation me WHERE me.id = rec.id);
      END IF;
    END;
  END LOOP;

  RAISE NOTICE 'bookings moved: % (%)',
    (SELECT count(*) FROM fix_target),
    coalesce((SELECT string_agg(status || ' ' || n, ', ' ORDER BY n DESC)
                FROM (SELECT status, count(*) n FROM fix_target GROUP BY 1) s), 'none');
  RAISE NOTICE 'reservations moved: % staff, % resource; % re-blocked',
    (SELECT count(*) FROM fix_staff), (SELECT count(*) FROM fix_resource), reblocked;
  IF left_alone > 0 THEN
    RAISE NOTICE 'left alone: % staff reservation(s) of these bookings were not at +04:00', left_alone;
  END IF;

  IF cardinality(clashes) > 0 THEN
    RAISE EXCEPTION 'NOTHING CHANGED: % reservation(s) would double-book once moved:%',
      cardinality(clashes), E'\n  ' || array_to_string(clashes, E'\n  ');
  END IF;

  SELECT count(*) INTO left_behind
    FROM booking
   WHERE round(extract(epoch FROM (trading_day + make_interval(mins => start_minute))
                                - (start_at AT TIME ZONE 'UTC')) / 60) = 240
     AND status NOT IN ('settled', 'cancelled', 'no_show', 'rescheduled', 'expired', 'skipped')
     AND (trading_day + make_interval(mins => start_minute)) AT TIME ZONE 'Asia/Dhaka' > now();
  IF left_behind > 0 THEN
    RAISE EXCEPTION 'NOTHING CHANGED: % booking(s) still at +04:00 after the move', left_behind;
  END IF;

  RAISE NOTICE 'every upcoming live booking is now on Asia/Dhaka';
END
$fix$;
