-- CreateEnum
-- In a DO block (hand-wrapped: CREATE TYPE has no IF NOT EXISTS), so a
-- re-run is a no-op.
DO $$ BEGIN
  CREATE TYPE "check_in_via" AS ENUM ('self', 'staff');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
-- IF NOT EXISTS hand-added, for the same reason. Nullable with no default:
-- Postgres records the column and rewrites nothing, however long the
-- history is.
ALTER TABLE "booking_status_history"
  ADD COLUMN IF NOT EXISTS "check_in_via" "check_in_via";


-- ============================================================ hand-written
-- Below this line: what Prisma cannot express (CLAUDE.md 3). Every statement
-- is safe to run twice, so a migration that dies half way can be re-run.

-- HOW, ON EVERY CHECK-IN AND NOWHERE ELSE. A move into CHECKED_IN says how
-- (self: the customer asked first; staff: the desk did it on its own), and
-- no other move does. NO DEFAULT on the column, on purpose: a caller that
-- forgot to say would be recorded as staff, look right, be wrong, and never
-- be found. Refused here instead, loudly, the first time it runs.
--
-- NOT VALID: the check-ins written before this have no way to know, and the
-- history is append-only (booking_status_history_append_only), so they stay
-- null, read as unknown, never guessed. NOT VALID skips them and holds every
-- row written from now on; it also takes no scan of the table to add.
DO $$ BEGIN
  ALTER TABLE booking_status_history
    ADD CONSTRAINT booking_status_history_check_in_says_how
    CHECK ((to_status = 'checked_in') = (check_in_via IS NOT NULL))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
