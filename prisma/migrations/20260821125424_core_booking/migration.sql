-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('draft', 'held', 'pending_payment', 'pending_confirmation', 'confirmed', 'checked_in', 'in_service', 'completed', 'settled', 'cancelled', 'no_show', 'rescheduled', 'expired', 'skipped');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('none_required', 'unpaid', 'deposit_paid', 'fully_paid', 'partially_refunded', 'refunded', 'forfeited', 'settled');

-- CreateEnum
CREATE TYPE "segment_kind" AS ENUM ('setup', 'active', 'processing', 'finishing', 'teardown');

-- CreateTable
CREATE TABLE "booking" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'draft',
    "payment_status" "payment_status" NOT NULL DEFAULT 'none_required',
    "trading_day" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "price_fils" INTEGER NOT NULL DEFAULT 0,
    "deposit_fils" INTEGER NOT NULL DEFAULT 0,
    "requirement_source" TEXT,
    "channel" TEXT NOT NULL,
    "move_count" SMALLINT NOT NULL DEFAULT 0,
    "overbooked" BOOLEAN NOT NULL DEFAULT false,
    "overbook_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_item" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "service_name" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "required_skill" TEXT NOT NULL,
    "price_fils" INTEGER NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "position" SMALLINT NOT NULL,
    "staff_id" UUID NOT NULL,

    CONSTRAINT "booking_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hold" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID,
    "trading_day" DATE NOT NULL,
    "feasibility_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_reservation" (
    "id" UUID NOT NULL,
    "booking_item_id" UUID,
    "hold_id" UUID,
    "branch_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "trading_day" DATE NOT NULL,
    "kind" "segment_kind" NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "staff_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_reservation" (
    "id" UUID NOT NULL,
    "booking_item_id" UUID,
    "hold_id" UUID,
    "branch_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_unit_id" UUID,
    "trading_day" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "resource_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_code_key" ON "booking"("code");

-- CreateIndex
CREATE INDEX "booking_branch_day_idx" ON "booking"("branch_id", "trading_day", "status");

-- CreateIndex
CREATE INDEX "booking_customer_idx" ON "booking"("customer_id", "start_at" DESC);

-- CreateIndex
CREATE INDEX "booking_item_booking_idx" ON "booking_item"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_item_booking_id_position_key" ON "booking_item"("booking_id", "position");

-- CreateIndex
CREATE INDEX "hold_expiry_idx" ON "hold"("expires_at");

-- CreateIndex
CREATE INDEX "staff_res_day_idx" ON "staff_reservation"("branch_id", "trading_day", "staff_id");

-- CreateIndex
CREATE INDEX "resource_res_day_idx" ON "resource_reservation"("branch_id", "trading_day", "resource_type");

-- AddForeignKey
ALTER TABLE "booking_item" ADD CONSTRAINT "booking_item_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_reservation" ADD CONSTRAINT "staff_reservation_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "hold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_booking_item_id_fkey" FOREIGN KEY ("booking_item_id") REFERENCES "booking_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservation" ADD CONSTRAINT "resource_reservation_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "hold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Raw SQL Prisma cannot express. Never let `migrate dev` drop these.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---- THE GUARANTEE -----------------------------------------
-- Two blocking reservations on one professional may never overlap.
-- Covers bookings AND holds, because both live in this table.
ALTER TABLE staff_reservation
  ADD CONSTRAINT staff_reservation_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (blocking);

-- Once a concrete chair is pinned at check-in, that unit cannot
-- be double-used. Unpinned rows are counted, not excluded.
ALTER TABLE resource_reservation
  ADD CONSTRAINT resource_reservation_unit_no_overlap
  EXCLUDE USING gist (
    resource_unit_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (blocking AND resource_unit_id IS NOT NULL);

-- ---- sanity checks -----------------------------------------
ALTER TABLE booking
  ADD CONSTRAINT booking_time_sane       CHECK (end_at > start_at),
  ADD CONSTRAINT booking_minute_sane     CHECK (start_minute BETWEEN 0 AND 1440),
  ADD CONSTRAINT booking_duration_sane   CHECK (duration_min > 0),
  ADD CONSTRAINT booking_money_sane      CHECK (price_fils >= 0 AND deposit_fils >= 0),
  ADD CONSTRAINT booking_overbook_reason CHECK (NOT overbooked OR overbook_reason IS NOT NULL);

ALTER TABLE booking_item
  ADD CONSTRAINT booking_item_price_sane CHECK (price_fils >= 0),
  ADD CONSTRAINT booking_item_dur_sane   CHECK (duration_min > 0);

-- A reservation belongs to a booking OR a hold. Never both, never neither.
ALTER TABLE staff_reservation
  ADD CONSTRAINT staff_res_time_sane CHECK (end_at > start_at),
  ADD CONSTRAINT staff_res_owner     CHECK (num_nonnulls(booking_item_id, hold_id) = 1);

ALTER TABLE resource_reservation
  ADD CONSTRAINT resource_res_time_sane CHECK (end_at > start_at),
  ADD CONSTRAINT resource_res_owner     CHECK (num_nonnulls(booking_item_id, hold_id) = 1);
