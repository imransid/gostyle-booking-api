-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "nudged_15m_at" TIMESTAMPTZ(6),
ADD COLUMN     "reminded_24h_at" TIMESTAMPTZ(6),
ADD COLUMN     "reminded_3h_at" TIMESTAMPTZ(6);

-- The scheduler runs every minute and asks the same question three times:
-- "which live bookings still owe this message?". Without an index that is a
-- full scan of every booking ever made, once a minute, forever.
--
-- PARTIAL, on the NULL side only. A sent reminder never becomes unsent, so
-- the rows that matter are a small and self-draining set: today's bookings
-- that have not had this message yet. The index stays tiny no matter how
-- many bookings accumulate.
CREATE INDEX IF NOT EXISTS booking_due_24h_idx ON booking (start_at)
  WHERE reminded_24h_at IS NULL
    AND status IN ('confirmed', 'pending_payment');

CREATE INDEX IF NOT EXISTS booking_due_3h_idx ON booking (start_at)
  WHERE reminded_3h_at IS NULL
    AND status IN ('confirmed', 'pending_payment');

CREATE INDEX IF NOT EXISTS booking_due_15m_idx ON booking (start_at)
  WHERE nudged_15m_at IS NULL
    AND status IN ('confirmed', 'pending_payment');
