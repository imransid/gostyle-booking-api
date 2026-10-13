-- CreateEnum
CREATE TYPE "check_in_request_state" AS ENUM ('waiting', 'approved', 'rejected', 'expired', 'closed');

-- CreateTable
CREATE TABLE "check_in_request" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT,
    "booking_id" UUID NOT NULL,
    "state" "check_in_request_state" NOT NULL DEFAULT 'waiting',
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by_kind" "actor_kind" NOT NULL,
    "raised_by_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_kind" "actor_kind",
    "decided_by_id" UUID,
    "reason" TEXT,

    CONSTRAINT "check_in_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_in_request_booking_idx" ON "check_in_request"("booking_id", "raised_at" DESC);

-- AddForeignKey
ALTER TABLE "check_in_request" ADD CONSTRAINT "check_in_request_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================ hand-written
-- Below this line: what Prisma cannot express (CLAUDE.md 3). Every statement
-- is safe to run twice, so a migration that dies half way can be re-run.

-- ONE CLAIM AT A TIME. A booking has at most one WAITING request. The raise
-- takes the booking's row lock and answers a second tap with the first
-- request, so this should never fire; it is here so that a raise written
-- without the lock fails loudly instead of leaving two claims for the desk
-- to answer twice. PARTIAL on waiting: the closed ones are history, and a
-- booking may collect several (a check-in undone, then raised again).
-- It is also the lapse job's index: it scans the waiting rows every minute,
-- and they are a small set that drains itself.
CREATE UNIQUE INDEX IF NOT EXISTS check_in_request_one_waiting_uq
  ON check_in_request (booking_id)
  WHERE state = 'waiting';

-- Waiting has no answer; every other state has one, with a time.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_answered_has_time
    CHECK ((state = 'waiting') = (decided_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The time and the kind of who answered come together or not at all.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_answer_is_whole
    CHECK ((decided_at IS NULL) = (decided_by_kind IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WHO MAY END IT. Approve and reject are the desk's: staff or manager, never
-- the system and never the customer. Expired and closed are the lapse job's
-- alone. A row that says the system approved somebody is a check-in nobody
-- looked at, which is the one thing this feature must never write.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_right_answerer
    CHECK (
      state = 'waiting'
      OR (state IN ('approved', 'rejected')
          AND decided_by_kind IN ('staff', 'manager'))
      OR (state IN ('expired', 'closed')
          AND decided_by_kind = 'system'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The system is nobody, and a person is somebody: as booking_status_history
-- holds it. "Who approved this?" must always have an answer.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_answerer_id
    CHECK (
      (decided_by_kind IS DISTINCT FROM 'system' OR decided_by_id IS NULL)
      AND (decided_by_kind NOT IN ('staff', 'manager')
           OR decided_by_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A rejection says why. It is what the desk reads back when the customer
-- comes to the counter asking, and what support reads a month later.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_rejection_says_why
    CHECK (state <> 'rejected' OR btrim(coalesce(reason, '')) <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
