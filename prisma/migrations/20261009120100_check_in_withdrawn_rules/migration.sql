-- ============================================================ hand-written
-- Nothing above this line: Prisma has nothing to generate here. Below it,
-- what Prisma cannot express (CLAUDE.md 3). Every statement is safe to run
-- twice, so a migration that dies half way can be re-run.
--
-- The customer's one answer to their own request: WITHDRAWN, taken back
-- before anybody answered. Its own migration, after the one that adds the
-- value (20261009120000_check_in_withdrawn_state): these CHECKs name it, and
-- Postgres will not use a value in the transaction that added it.

-- WHO MAY END IT, now with the customer's move. Approve and reject stay the
-- desk's, expired and closed stay the lapse job's, and withdrawn is the
-- customer's alone: a desk that wants a request gone rejects it, with a
-- reason, and the job never takes a claim back on anybody's behalf. Replaced
-- whole (dropped, then added), because a CHECK cannot be altered; existing
-- rows are checked again as it is added, and every one of them passes the
-- old rule, which this keeps.
ALTER TABLE check_in_request
  DROP CONSTRAINT IF EXISTS check_in_request_right_answerer;
ALTER TABLE check_in_request
  ADD CONSTRAINT check_in_request_right_answerer
  CHECK (
    state = 'waiting'
    OR (state IN ('approved', 'rejected')
        AND decided_by_kind IN ('staff', 'manager'))
    OR (state IN ('expired', 'closed')
        AND decided_by_kind = 'system')
    OR (state = 'withdrawn'
        AND decided_by_kind = 'customer'));

-- The system is nobody, and a person is somebody, the customer now among
-- them: "who took this back?" must always have an answer.
ALTER TABLE check_in_request
  DROP CONSTRAINT IF EXISTS check_in_request_answerer_id;
ALTER TABLE check_in_request
  ADD CONSTRAINT check_in_request_answerer_id
  CHECK (
    (decided_by_kind IS DISTINCT FROM 'system' OR decided_by_id IS NULL)
    AND (decided_by_kind NOT IN ('staff', 'manager', 'customer')
         OR decided_by_id IS NOT NULL));

-- ONLY THE ONE WHO ASKED TAKES IT BACK. The route already holds a customer
-- to their own booking; this keeps a withdrawal written by anybody else from
-- saying the customer changed their mind.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_withdrawn_by_raiser
    CHECK (state <> 'withdrawn' OR decided_by_id = raised_by_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
