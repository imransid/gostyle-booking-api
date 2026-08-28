-- CreateEnum
CREATE TYPE "walk_in_status" AS ENUM ('waiting', 'seated', 'left');

-- CreateTable
CREATE TABLE "walk_in_entry" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trading_day" DATE NOT NULL,
    "customer_id" UUID,
    "guest_name" TEXT,
    "service_ids" TEXT[],
    "duration_min" SMALLINT NOT NULL,
    "status" "walk_in_status" NOT NULL DEFAULT 'waiting',
    "booking_id" UUID,
    "joined_min" SMALLINT NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "walk_in_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "walk_in_entry_booking_id_key" ON "walk_in_entry"("booking_id");

-- CreateIndex
CREATE INDEX "walk_in_day_idx" ON "walk_in_entry"("branch_id", "trading_day");

-- ============================================================ the rules

ALTER TABLE walk_in_entry
  -- A walk-in is EITHER a registered customer OR somebody who gave a name.
  -- Both is two identities for one person standing at the desk; neither is a
  -- place in the queue nobody can be called from.
  ADD CONSTRAINT walk_in_is_customer_or_guest
    CHECK (num_nonnulls(customer_id, guest_name) = 1),

  -- They want something. An empty list is a queue entry that can never be
  -- quoted, so it would sit there being skipped forever.
  ADD CONSTRAINT walk_in_wants_something
    CHECK (array_length(service_ids, 1) >= 1),

  ADD CONSTRAINT walk_in_duration_positive
    CHECK (duration_min > 0),

  ADD CONSTRAINT walk_in_joined_inside_trading_day
    CHECK (joined_min >= 600 AND joined_min < 1320),

  -- Seated means seated INTO something. A seated entry with no booking is a
  -- person the desk believes was served and who has no appointment.
  ADD CONSTRAINT walk_in_seated_has_booking
    CHECK (
      CASE status
        WHEN 'seated' THEN booking_id IS NOT NULL
        ELSE TRUE
      END
    );

-- The queue: today's branch, still waiting, oldest first.
--
-- PARTIAL on 'waiting'. Everyone seated or gone is dead weight to the one
-- question this index exists to answer, and yesterday's queue is never read
-- again.
CREATE INDEX IF NOT EXISTS walk_in_queue_idx
  ON walk_in_entry (branch_id, trading_day, joined_min)
  WHERE status = 'waiting';
