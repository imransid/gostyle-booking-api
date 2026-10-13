-- AlterTable
ALTER TABLE "check_in_request" ADD COLUMN     "chair_id" UUID,
ADD COLUMN     "chair_number" TEXT,
ADD COLUMN     "chair_zone_name" TEXT;


-- ============================================================ hand-written
-- Below this line: what Prisma cannot express (CLAUDE.md 3). Every statement
-- is safe to run twice, so a migration that dies half way can be re-run.

-- A CHAIR IS ITS ID AND ITS NUMBER, TOGETHER. The id is what "who is in this
-- chair" matches on; the number is what the desk is told. An id with no
-- number is a claim the desk cannot read, and a number with no id is one
-- nobody can match: either would be a chair check-in that half happened.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_chair_is_whole
    CHECK ((chair_id IS NULL) = (chair_number IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The number is read out at the desk: never blank.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_chair_number_not_blank
    CHECK (chair_number IS NULL OR btrim(chair_number) <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A zone is a chair's: no zone name on a request with no chair.
DO $$ BEGIN
  ALTER TABLE check_in_request
    ADD CONSTRAINT check_in_request_zone_has_chair
    CHECK (chair_zone_name IS NULL OR chair_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- NO INDEX ON chair_id, on purpose. The one query that asks who is in a chair
-- (occupantOf, check-in-request.repository.ts) starts from the claiming
-- booking's branch and trading day, which booking_branch_day_idx serves, and
-- reads each booking's latest request through check_in_request_booking_idx.
-- An index on chair_id would serve no query and cost every insert.
