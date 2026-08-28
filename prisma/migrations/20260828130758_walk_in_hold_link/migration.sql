-- AlterTable
ALTER TABLE "walk_in_entry" ADD COLUMN     "hold_id" UUID;

-- Finding the queue entry from the hold that is about to become a booking.
-- Partial, because only a walk-in mid-seating carries one.
CREATE INDEX IF NOT EXISTS walk_in_hold_idx
  ON walk_in_entry (hold_id)
  WHERE hold_id IS NOT NULL;
