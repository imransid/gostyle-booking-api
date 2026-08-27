-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'offered', 'accepted', 'expired', 'left');

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_id" TEXT NOT NULL,
    "trading_day" DATE NOT NULL,
    "window_from_min" SMALLINT NOT NULL,
    "window_to_min" SMALLINT NOT NULL,
    "preferred_staff_id" UUID,
    "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
    "decline_count" SMALLINT NOT NULL DEFAULT 0,
    "declined_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offered_booking_code" TEXT,
    "offer_expires_at" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_match_idx" ON "waitlist_entry"("branch_id", "trading_day", "service_id");

-- CreateIndex
CREATE INDEX "waitlist_offer_expiry_idx" ON "waitlist_entry"("offer_expires_at");

-- A window that ends before it starts is not a window.
ALTER TABLE waitlist_entry
  ADD CONSTRAINT waitlist_window_sane CHECK (window_to_min > window_from_min),
  ADD CONSTRAINT waitlist_window_in_day
    CHECK (window_from_min >= 0 AND window_to_min <= 1440),
  -- An offer is a pair: a code and an expiry, or neither. One without the
  -- other is a row nobody can act on and nobody can clean up.
  ADD CONSTRAINT waitlist_offer_paired
    CHECK (num_nonnulls(offered_booking_code, offer_expires_at) <> 1),
  -- The cap is the rule, not a suggestion. A row past it must not be waiting.
  ADD CONSTRAINT waitlist_cap_respected
    CHECK (decline_count < 3 OR status <> 'waiting');

-- The matching query asks one thing: who is still waiting for this service
-- on this day? PARTIAL on the live statuses, because entries that have been
-- served or have left never match again, and a full index would grow with
-- every entry ever created rather than with the queue.
CREATE INDEX IF NOT EXISTS waitlist_live_idx
  ON waitlist_entry (branch_id, trading_day, service_id, joined_at)
  WHERE status IN ('waiting', 'offered');
