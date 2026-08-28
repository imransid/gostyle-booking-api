-- The payload check passed on an empty weekday list, and the proof caught it.
--
-- array_length(ARRAY[]::smallint[], 1) is NULL, not 0. A CHECK rejects only
-- FALSE, so the whole CASE evaluated to NULL and the row went in. A weekly
-- series with no weekdays expands to nothing: the client is told they have a
-- standing appointment and no appointment is ever made.
--
-- The same hole existed twice more:
--   custom          -- an empty date list, identical NULL from array_length
--   monthly_on_date -- a NULL day_of_month, because NULL BETWEEN 1 AND 31 is NULL
--
-- Every branch now states its own NOT NULL rather than relying on a
-- comparison to do it, because a comparison against NULL never says no.
ALTER TABLE booking_series
  DROP CONSTRAINT IF EXISTS series_payload_matches_pattern;

ALTER TABLE booking_series
  ADD CONSTRAINT series_payload_matches_pattern
    CHECK (
      CASE pattern
        WHEN 'weekly'
          THEN COALESCE(array_length(weekdays, 1), 0) BETWEEN 1 AND 7
        WHEN 'every_n_weeks'
          THEN interval_weeks IS NOT NULL AND interval_weeks >= 1
        WHEN 'monthly_on_date'
          THEN day_of_month IS NOT NULL AND day_of_month BETWEEN 1 AND 31
        WHEN 'custom'
          THEN COALESCE(array_length(custom_dates, 1), 0) >= 1
      END
    );
