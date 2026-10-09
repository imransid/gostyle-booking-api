-- AlterEnum
-- IF NOT EXISTS (hand-added to Prisma's line) so a re-run is a no-op.
--
-- ALONE IN ITS MIGRATION, ON PURPOSE. Postgres refuses to use an enum value
-- in the transaction that added it ("unsafe use of new value"), and the
-- CHECKs that name 'withdrawn' are in the next migration,
-- 20261009120100_check_in_withdrawn_rules.
ALTER TYPE "check_in_request_state" ADD VALUE IF NOT EXISTS 'withdrawn';
