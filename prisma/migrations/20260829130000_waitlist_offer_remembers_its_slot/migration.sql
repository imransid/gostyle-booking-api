-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "offered_duration_min" SMALLINT,
ADD COLUMN     "offered_staff_id" UUID,
ADD COLUMN     "offered_start_min" SMALLINT;

-- ---------------------------------------------------------------------------
-- Raw, because Prisma cannot express a CHECK (CLAUDE.md 3).
--
-- The offer was already all-or-nothing across two columns. It is now five,
-- and the reason the other three arrived is that deriving the slot from the
-- booking row was wrong the moment a reschedule moved that row: the offer
-- described where the booking WENT, not what it freed, so accept 409'd on a
-- slot the booking itself was sitting in.
--
-- num_nonnulls, not five OR'd IS NULLs: one expression that says "either
-- there is an offer or there is not" cannot drift into permitting four.
--
-- Existing rows are grandfathered. Any offer written before this migration
-- has three NULLs and would violate the strict form, so live offers are
-- lapsed first -- a waitlist offer is minutes long, and re-offering the slot
-- is exactly what the sweeper already does.
-- ---------------------------------------------------------------------------

UPDATE "waitlist_entry"
   SET status = 'waiting',
       offered_booking_code = NULL,
       offer_expires_at = NULL
 WHERE status = 'offered';

ALTER TABLE "waitlist_entry" DROP CONSTRAINT IF EXISTS "waitlist_offer_paired";

ALTER TABLE "waitlist_entry"
  ADD CONSTRAINT "waitlist_offer_paired"
  CHECK (num_nonnulls(offered_booking_code, offer_expires_at,
                      offered_start_min, offered_duration_min,
                      offered_staff_id) IN (0, 5));
