-- The app customer's own reminder (MOBILE_REMINDER_CHOICE): one per visit,
-- at the time they chose in the app (30 minutes, 1 hour, 2 hours or 1 day
-- before), instead of the three fixed rungs.
--
-- reminded_chosen_at: when the ladder claimed it, sent or passed over. NULL
-- means outstanding, as for the fixed rungs, and that is what it claims on.
-- reminder_lead_min: the lead it was claimed with, for support and the
-- words.
--
-- IF NOT EXISTS hand-added, so a migration that dies half way can be re-run.
-- Nullable with no default: Postgres records the columns and rewrites
-- nothing. The old image never names them.
ALTER TABLE "booking"
  ADD COLUMN IF NOT EXISTS "reminded_chosen_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reminder_lead_min" SMALLINT;

-- The ladder's question every minute: app bookings, still live, starting in
-- the next day, not yet claimed. Partial, so it holds only those rows.
CREATE INDEX IF NOT EXISTS "booking_chosen_reminder_idx"
  ON "booking" ("start_at")
  WHERE "reminded_chosen_at" IS NULL
    AND "channel" = 'online'
    AND "status" IN ('confirmed', 'pending_payment');
