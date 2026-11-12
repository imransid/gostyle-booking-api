-- Bookings -> POS open tickets (gostyle-platform docs/booking-pos-tickets-plan.md).
--
-- Three things:
--   1. booking.pos_ticket_id / pos_ticket_number: the till's ticket for the
--      visit, written by the sync worker and the paid callback.
--   2. deposit_ledger.vat_fils: the VAT inside a row when the till decided
--      the split, so the books reverse exactly what capture declared.
--   3. pos_ticket_sync: booking events on their way to the platform's POS,
--      one booking's rows strictly in order (the queue the worker drains).
--
-- Written to be re-runnable (CLAUDE.md 3): every statement survives a second
-- run after a migration that died half way.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "pos_sync_kind" AS ENUM ('open', 'status');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "pos_sync_status" AS ENUM ('pending', 'done', 'parked', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterTable: nullable, no default. Every existing booking has no ticket and
-- every existing ledger row takes the booking's own VAT proportion, which is
-- exactly what NULL means for both.
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "pos_ticket_id" UUID;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "pos_ticket_number" TEXT;
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "vat_fils" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "pos_ticket_sync" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_at" TIMESTAMPTZ(6) NOT NULL,
    "booking_id" UUID NOT NULL,
    "kind" "pos_sync_kind" NOT NULL,
    "booking_status" TEXT NOT NULL,
    "status" "pos_sync_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "last_error_code" TEXT,
    "ticket_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_ticket_sync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pos_ticket_sync_event_id_key" ON "pos_ticket_sync"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pos_ticket_sync_booking_idx" ON "pos_ticket_sync"("booking_id", "event_at");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "pos_ticket_sync" ADD CONSTRAINT "pos_ticket_sync_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ============================================================ what Prisma cannot express

-- BOTH OR NEITHER. A ticket id with no number is a ticket the desk cannot
-- name; a number with no id is one nobody can look up.
DO $$
BEGIN
  ALTER TABLE booking
    ADD CONSTRAINT booking_pos_ticket_pair CHECK (
      (pos_ticket_id IS NULL) = (pos_ticket_number IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- THE TILL'S SPLIT, AND ONLY WHERE THE TILL DECIDED IT. vat_fils overrides
-- the booking's VAT proportion when the journal posts the row, so a value
-- on any other row type would silently change how a capture or a forfeit is
-- booked. It is a part of the row, so it can never exceed what the row
-- moves, and never be negative (the side comes from the type, not a sign).
--
-- Every IS NOT NULL is spelled out: a CHECK that comes out NULL passes.
DO $$
BEGIN
  ALTER TABLE deposit_ledger
    ADD CONSTRAINT deposit_ledger_vat_fils_sane CHECK (
      vat_fils IS NULL
      OR (
        entry_type IN ('applied_at_pos', 'refunded')
        AND vat_fils >= 0
        AND vat_fils <= abs(amount_fils)
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ONE DRAW-DOWN PER TICKET. The paid callback is retried by the platform's
-- outbox and replayed by the safety net; this is what makes a second
-- delivery write nothing even if both race past the booking lock's replay
-- check. PARTIAL: only applied_at_pos carries the ticket as its key -- the
-- leftover credited at the same settlement names the ticket too.
CREATE UNIQUE INDEX IF NOT EXISTS deposit_ledger_pos_applied_once
  ON deposit_ledger (pos_transaction_id)
  WHERE entry_type = 'applied_at_pos' AND pos_transaction_id IS NOT NULL;

-- THE KIND SAYS WHICH STATUSES IT CAN CARRY. An open row for "completed"
-- would be sent as an open and create a ticket for a visit already over; a
-- status row for "checked_in" has no status to send.
DO $$
BEGIN
  ALTER TABLE pos_ticket_sync
    ADD CONSTRAINT pos_ticket_sync_kind_matches CHECK (
      (kind = 'open' AND booking_status = 'checked_in')
      OR (
        kind = 'status'
        AND booking_status IN (
          'in_service', 'completed', 'check_in_undone', 'cancelled', 'no_show'
        )
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE pos_ticket_sync
    ADD CONSTRAINT pos_ticket_sync_attempts_sane CHECK (attempts >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- A parked row says why, or nobody can fix it.
DO $$
BEGIN
  ALTER TABLE pos_ticket_sync
    ADD CONSTRAINT pos_ticket_sync_parked_says_why CHECK (
      status <> 'parked' OR last_error_code IS NOT NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The worker's claim, every five seconds forever, and the /health counts.
-- PARTIAL: pending and parked are the transient states, and the table grows
-- by one row per check-in, start, completion and void forever. Unpredicated,
-- each index would carry every row ever sent to find the handful moving.
CREATE INDEX IF NOT EXISTS pos_ticket_sync_due_idx
  ON pos_ticket_sync (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pos_ticket_sync_parked_idx
  ON pos_ticket_sync (created_at)
  WHERE status = 'parked';

-- The safety net's scan (a paid callback that never arrived): completed
-- visits with a live ticket, every five minutes forever. PARTIAL for the
-- same reason: a booking is in that state for minutes, and settled or
-- historic bookings vastly outnumber it.
CREATE INDEX IF NOT EXISTS booking_pos_unsettled_idx
  ON booking (updated_at)
  WHERE status = 'completed' AND pos_ticket_id IS NOT NULL;
