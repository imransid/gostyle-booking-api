-- Three CHECKs pinned a start to the old fixed trading day. They now guard the
-- clock day instead, because the trading day is no longer one fixed range.
--
-- series_start_inside_trading_day, occurrence_start_inside_trading_day and
-- walk_in_joined_inside_trading_day each said 600 <= minute < 1320: the
-- 10:00-22:00 day, copied out of src/domain/availability/grid.ts into the
-- schema. That day is now per branch and per date (DayContext.window), and a
-- database cannot know it. What it can guard is what booking_minute_sane
-- already guards on booking.start_minute: a real minute of the day. Whether
-- the minute is inside the branch's hours is the engine's question, asked
-- against that date's window (alignmentMask).
--
-- Left as they were, a branch that trades until 23:00 would be offered 22:30
-- by the engine and then have the insert refused here: the offered-then-
-- refused bug the trading window exists to end, moved into the database.
--
-- < 1440, not <= 1440 as booking_minute_sane allows. These are STARTS, and a
-- start at 24:00 is 00:00 of the next trading day filed under this one.
--
-- RENAMED, not only widened: a constraint called "inside_trading_day" that no
-- longer checks the trading day would mislead whoever reads the error next.
--
-- One ALTER per table, so the drop and the add are a single statement and
-- the column is never unguarded in between. Retry-safe (CLAUDE.md 3): both
-- the old and the new name are dropped IF EXISTS before the add, so a re-run
-- after a partial apply lands in the same place. Widening cannot fail on
-- existing rows: every row that passed 600..1319 passes 0..1439.

ALTER TABLE booking_series
  DROP CONSTRAINT IF EXISTS series_start_inside_trading_day,
  DROP CONSTRAINT IF EXISTS series_start_inside_clock_day,
  ADD CONSTRAINT series_start_inside_clock_day
    CHECK (start_min >= 0 AND start_min < 1440);

ALTER TABLE series_occurrence
  DROP CONSTRAINT IF EXISTS occurrence_start_inside_trading_day,
  DROP CONSTRAINT IF EXISTS occurrence_start_inside_clock_day,
  ADD CONSTRAINT occurrence_start_inside_clock_day
    CHECK (planned_start_min >= 0 AND planned_start_min < 1440);

ALTER TABLE walk_in_entry
  DROP CONSTRAINT IF EXISTS walk_in_joined_inside_trading_day,
  DROP CONSTRAINT IF EXISTS walk_in_joined_inside_clock_day,
  ADD CONSTRAINT walk_in_joined_inside_clock_day
    CHECK (joined_min >= 0 AND joined_min < 1440);
