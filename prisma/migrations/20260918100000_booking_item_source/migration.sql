-- Which catalogue priced each booking line.
--
-- GS-1222 was reported as a lost factor of ten between the platform
-- catalogue and price_fils. It turned out to be a measurement error, but
-- finding that out took reading two catalogues, a stub server and a log,
-- because the ROW ITSELF records no provenance. Stage 1 of the
-- slug-to-uuid migration means a price can now come from platform over
-- gRPC or from the static fixture, and those two can disagree.
--
-- This makes "where did this number come from" a column rather than an
-- investigation.

-- CreateEnum
--
-- Hand-written rather than left to Prisma's generated block because
-- CREATE TYPE has no IF NOT EXISTS and a half-applied migration must be
-- re-runnable (CLAUDE.md 3; 5208162 and aa47bc9 were both fixes for
-- migrations that were not).
DO $$
BEGIN
  CREATE TYPE "catalogue_source" AS ENUM ('platform', 'fixture', 'mixed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterTable
--
-- NO DEFAULT AND NO BACKFILL, deliberately. Every existing row was written
-- before this was recorded, and NULL says exactly that. Defaulting them to
-- 'fixture' would be an inference stored as a fact -- almost certainly
-- correct today, and indistinguishable from a real record the moment it is
-- not. A reader can tell "unrecorded" from "fixture" only while we refuse
-- to guess.
--
-- It also makes this a metadata-only change: no table rewrite, no lock held
-- while 40k rows are updated.
ALTER TABLE "booking_item" ADD COLUMN IF NOT EXISTS "source" "catalogue_source";

COMMENT ON COLUMN "booking_item"."source" IS
  'Which catalogue priced this line: platform (gRPC), fixture (static slug '
  'map), or mixed (a group row summing both). NULL means the row predates '
  'this column -- not that the source is unknown-but-recordable.';
