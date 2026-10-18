-- AlterTable
-- IF NOT EXISTS hand-added, so a migration that dies half way can be re-run.
-- Nullable with no default: Postgres records the columns and rewrites
-- nothing, however many items there are, and every line written before
-- this reads as a hand-picked service, which is what it was.
ALTER TABLE "booking_item"
  ADD COLUMN IF NOT EXISTS "package_id" UUID,
  ADD COLUMN IF NOT EXISTS "package_name" TEXT,
  ADD COLUMN IF NOT EXISTS "package_seq" SMALLINT;


-- ============================================================ hand-written
-- Below this line: what Prisma cannot express (CLAUDE.md 3). Every statement
-- is safe to run twice.

-- ALL THREE OR NONE, AND A NAME THAT SAYS SOMETHING. A line that names a
-- package id but no name would show the customer a blank where "Groom and
-- Go" belongs, and a name with no id could never be matched back to the
-- package it claims. A blank name is the same blank. Without its sale
-- number, the same package bought twice reads back as one at double the
-- price. Refused here, the first time a caller gets it wrong, rather than
-- found on a receipt.
--
-- EVERY `IS NOT NULL` IS SPELLED OUT, and none is redundant. Without them
-- a missing name makes length(btrim(NULL)) > 0 NULL rather than false, and
-- a CHECK that comes out NULL PASSES: the first proof run let an id with no
-- name straight through (prisma/proof-booking-item-package.sql, TEST 3).
--
-- Added with validation, on purpose: the columns are new in this same
-- migration, so every existing row is all-null and passes, and there is
-- nothing a NOT VALID would spare.
DO $$ BEGIN
  ALTER TABLE booking_item
    ADD CONSTRAINT booking_item_package_named
    CHECK (
      (package_id IS NULL AND package_name IS NULL AND package_seq IS NULL)
      OR (
        package_id IS NOT NULL
        AND package_name IS NOT NULL
        AND length(btrim(package_name)) > 0
        AND package_seq IS NOT NULL
        AND package_seq >= 0
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
