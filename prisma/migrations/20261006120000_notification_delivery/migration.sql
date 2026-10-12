-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('push', 'email');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'sent', 'failed', 'skipped', 'superseded');

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "event_type" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'pending',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "skip_reason" TEXT,
    "provider_ref" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_delivery_booking_idx" ON "notification_delivery"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_event_channel_uq" ON "notification_delivery"("source_event_id", "channel");

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================ hand-written
-- Below this line: what Prisma cannot express (CLAUDE.md 3). Every statement
-- is safe to run twice, so a migration that dies half way can be re-run.

-- The dispatcher asks "which deliveries are due?" every ten seconds, forever.
-- PARTIAL, on pending only: a delivery that is sent, failed, skipped or
-- superseded never becomes pending again, so the rows that matter are a small
-- self-draining set -- the next few minutes of reminders -- and the index
-- stays tiny however many have ever been sent.
CREATE INDEX IF NOT EXISTS notification_delivery_due_idx
  ON notification_delivery (next_attempt_at)
  WHERE status = 'pending';

-- A row that says sent says when; a row that does not, does not. Without this
-- a half-written update could report a reminder as delivered with no time, or
-- a time against a reminder that never went.
DO $$ BEGIN
  ALTER TABLE notification_delivery
    ADD CONSTRAINT notification_delivery_sent_has_time
    CHECK ((status = 'sent') = (sent_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A skip always says why (no_email, opted_out, booking_cancelled, ...).
-- "Skipped" with no reason is the support ticket nobody can answer.
DO $$ BEGIN
  ALTER TABLE notification_delivery
    ADD CONSTRAINT notification_delivery_skip_has_reason
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE notification_delivery
    ADD CONSTRAINT notification_delivery_attempts_not_negative
    CHECK (attempts >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
