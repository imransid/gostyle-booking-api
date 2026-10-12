-- Journal sync: each deposit_ledger row carries whether it has reached the
-- platform's general ledger (docs/journal-integration.md).
--
-- THE BOOKS LIVE ON THE PLATFORM. Nothing here copies an entry, an account or
-- a line; these columns are the delivery receipt and nothing more, kept
-- because the platform cannot tell us about an entry it never received. A
-- payment made while it was down would otherwise never reach the books.
--
-- THE CUTOVER IS THIS MIGRATION. The columns are added with NO default and
-- the defaults set afterwards, so every row already in the ledger keeps a
-- NULL status ("before the cutover, never posted") and only rows written
-- from now on are sent. Prisma's generated form -- ADD COLUMN ... DEFAULT
-- 'pending' -- would have filled every historical row and posted all of it.
-- Posting history is a deliberate one-off UPDATE (see the doc).
--
-- Written to be re-runnable (CLAUDE.md 3).

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "journal_sync_status" AS ENUM ('pending', 'posted', 'parked', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterTable: nullable, no default, so existing rows stay NULL.
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_sync_status" "journal_sync_status";
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_entry_id" UUID;
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_next_at" TIMESTAMPTZ(6);
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_error" TEXT;
ALTER TABLE "deposit_ledger" ADD COLUMN IF NOT EXISTS "journal_error_code" TEXT;

-- Then the defaults, which apply to new rows only.
ALTER TABLE "deposit_ledger" ALTER COLUMN "journal_sync_status" SET DEFAULT 'pending';
ALTER TABLE "deposit_ledger" ALTER COLUMN "journal_next_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ============================================================ what Prisma cannot express

-- `posted` means the platform handed back an entry; without its id the entry
-- can never be voided or found.
DO $$
BEGIN
  ALTER TABLE deposit_ledger
    ADD CONSTRAINT deposit_ledger_journal_posted_has_entry CHECK (
      journal_sync_status IS DISTINCT FROM 'posted' OR journal_entry_id IS NOT NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- A pending row with no next attempt would wait forever, unseen by the worker.
DO $$
BEGIN
  ALTER TABLE deposit_ledger
    ADD CONSTRAINT deposit_ledger_journal_pending_is_scheduled CHECK (
      journal_sync_status IS DISTINCT FROM 'pending' OR journal_next_at IS NOT NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE deposit_ledger
    ADD CONSTRAINT deposit_ledger_journal_attempts_sane CHECK (journal_attempts >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- APPEND-ONLY, EXCEPT THE RECEIPT.
--
-- deposit_ledger_append_only refused every UPDATE (gs_refuse_mutation, shared
-- with booking_status_history, which keeps it). The ledger now needs exactly
-- one kind of update -- the journal_* columns, as delivery progresses -- so it
-- gets its own guard: an UPDATE passes only if every OTHER column is
-- unchanged. Money, type, rail, actor and time stay immutable; a DELETE is
-- still refused outright.
CREATE OR REPLACE FUNCTION gs_deposit_ledger_append_only() RETURNS trigger AS $$
DECLARE
  sync_columns CONSTANT text[] := ARRAY[
    'journal_sync_status', 'journal_entry_id', 'journal_attempts',
    'journal_next_at', 'journal_error', 'journal_error_code'
  ];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) - sync_columns) = (to_jsonb(NEW) - sync_columns) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'table % is append-only; % is not allowed. Write a linked correcting row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deposit_ledger_append_only ON deposit_ledger;
CREATE TRIGGER deposit_ledger_append_only
  BEFORE UPDATE OR DELETE ON deposit_ledger
  FOR EACH ROW EXECUTE FUNCTION gs_deposit_ledger_append_only();

-- The worker's claim, and what /health counts on every probe. PARTIAL: both
-- states are transient, and the ledger grows by one row per money movement
-- forever. Unpredicated, each would index every posted row ever made to find
-- the handful still moving.
CREATE INDEX IF NOT EXISTS deposit_ledger_journal_due_idx
  ON deposit_ledger (journal_next_at)
  WHERE journal_sync_status = 'pending';

CREATE INDEX IF NOT EXISTS deposit_ledger_journal_parked_idx
  ON deposit_ledger (created_at)
  WHERE journal_sync_status = 'parked';
