-- The sweeper asks one question every minute: which confirmed bookings are
-- more than thirty minutes past their start?
--
-- PARTIAL on 'confirmed' alone. A booking leaves that status within hours and
-- never returns, so the index covers today's live bookings rather than every
-- booking ever taken. Without the predicate this grows forever and is scanned
-- once a minute for the rest of the system's life.
CREATE INDEX IF NOT EXISTS booking_auto_no_show_idx
  ON booking (start_at)
  WHERE status = 'confirmed';
