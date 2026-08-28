-- CreateEnum
CREATE TYPE "roster_change_kind" AS ENUM ('shift_conflict', 'closure_sweep', 'chair_out_of_service');

-- CreateEnum
CREATE TYPE "worklist_item_state" AS ENUM ('open', 'auto_repaired', 'resolved', 'overridden', 'cancelled');

-- CreateTable
CREATE TABLE "roster_change" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trading_day" DATE NOT NULL,
    "kind" "roster_change_kind" NOT NULL,
    "staff_id" UUID,
    "resource_type" TEXT,
    "reason" TEXT NOT NULL,
    "committed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roster_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_change_item" (
    "id" UUID NOT NULL,
    "change_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "booking_code" TEXT NOT NULL,
    "state" "worklist_item_state" NOT NULL DEFAULT 'open',
    "rung" TEXT,
    "proposal" JSONB,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_change_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_change_day_idx" ON "roster_change"("branch_id", "trading_day");

-- CreateIndex
CREATE INDEX "worklist_change_idx" ON "roster_change_item"("change_id");

-- CreateIndex
CREATE UNIQUE INDEX "worklist_booking_uniq" ON "roster_change_item"("change_id", "booking_id");

-- AddForeignKey
ALTER TABLE "roster_change_item" ADD CONSTRAINT "roster_change_item_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "roster_change"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================ the commit gate

-- A shift conflict names a professional; a chair going out of service names a
-- type. A change that names neither has nothing to scan for, and a change that
-- names both is two changes wearing one hat.
ALTER TABLE roster_change
  ADD CONSTRAINT roster_change_names_its_subject
    CHECK (
      CASE kind
        WHEN 'shift_conflict'       THEN staff_id IS NOT NULL AND resource_type IS NULL
        WHEN 'chair_out_of_service' THEN resource_type IS NOT NULL AND staff_id IS NULL
        WHEN 'closure_sweep'        THEN staff_id IS NULL AND resource_type IS NULL
      END
    );

ALTER TABLE roster_change_item
  -- A proposal is the prepared cancellation an item is WAITING on. Once the
  -- item is settled the proposal has either been applied or abandoned, and
  -- leaving it behind is a stale offer somebody will later read as live.
  ADD CONSTRAINT worklist_proposal_only_while_open
    CHECK (proposal IS NULL OR state = 'open'),

  -- Settled means somebody or something settled it, at a time.
  ADD CONSTRAINT worklist_resolved_at_matches_state
    CHECK (
      (state = 'open' AND resolved_at IS NULL)
      OR (state <> 'open' AND resolved_at IS NOT NULL)
    );

-- THE COMMIT GATE.
--
-- "The roster edit that caused the disruption cannot be committed while the
-- worklist is non-empty." Enforced here rather than in the application,
-- because the roster lives in another service and a guarantee that depends on
-- a remote caller remembering to ask is not a guarantee. This is the line that
-- stops a shift change quietly stranding customers who would only discover the
-- problem when they arrive.
--
-- A trigger rather than a CHECK: the rule counts rows in another table, and a
-- CHECK cannot see them.
CREATE OR REPLACE FUNCTION roster_change_gate() RETURNS trigger AS $$
DECLARE still_open integer;
BEGIN
  -- Only a commit is gated. Creating, scanning and resolving are all free.
  IF NEW.committed_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO still_open
    FROM roster_change_item
   WHERE change_id = NEW.id
     AND state = 'open';

  IF still_open > 0 THEN
    RAISE EXCEPTION
      'Roster change % cannot commit: % booking(s) still unresolved',
      NEW.id, still_open
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_change_commit_gate
  BEFORE UPDATE OF committed_at ON roster_change
  FOR EACH ROW EXECUTE FUNCTION roster_change_gate();

-- A committed change is history. Reopening one would mean the roster service
-- already acted on an answer we then took back.
CREATE OR REPLACE FUNCTION roster_change_commit_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.committed_at IS NOT NULL AND NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
    RAISE EXCEPTION 'Roster change % is already committed; commits are final', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_change_commit_final
  BEFORE UPDATE ON roster_change
  FOR EACH ROW EXECUTE FUNCTION roster_change_commit_is_final();

-- An item settled on a committed change would move the gate after the fact.
CREATE OR REPLACE FUNCTION worklist_item_frozen_after_commit() RETURNS trigger AS $$
DECLARE committed timestamptz;
BEGIN
  SELECT committed_at INTO committed FROM roster_change
   WHERE id = COALESCE(NEW.change_id, OLD.change_id);

  IF committed IS NOT NULL THEN
    RAISE EXCEPTION 'Roster change % is committed; its worklist is closed',
      COALESCE(NEW.change_id, OLD.change_id)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER worklist_item_frozen
  BEFORE INSERT OR UPDATE ON roster_change_item
  FOR EACH ROW EXECUTE FUNCTION worklist_item_frozen_after_commit();

-- The gate asks one question: is anything still open on this change?
--
-- PARTIAL on 'open'. Settled items are the overwhelming majority the moment a
-- worklist is worked through, and they are exactly the rows the gate does not
-- care about.
CREATE INDEX IF NOT EXISTS worklist_open_idx
  ON roster_change_item (change_id)
  WHERE state = 'open';

-- Uncommitted changes, for the desk's list of what is still blocking.
CREATE INDEX IF NOT EXISTS roster_change_pending_idx
  ON roster_change (branch_id, trading_day)
  WHERE committed_at IS NULL;
