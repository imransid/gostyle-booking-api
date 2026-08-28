-- The sweeper asks twice a minute: which links are past half time, and which
-- have closed? PARTIAL on pending_payment, because a booking leaves that
-- status within hours and never returns, so the index tracks the open links
-- rather than every booking ever taken.
CREATE INDEX IF NOT EXISTS booking_link_window_idx
  ON booking (link_expires_at)
  WHERE status = 'pending_payment' AND link_expires_at IS NOT NULL;
