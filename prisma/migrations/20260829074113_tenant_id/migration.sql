-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "booking_group" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "booking_series" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "roster_change" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "tenant_id" TEXT;

-- AlterTable
ALTER TABLE "walk_in_entry" ADD COLUMN     "tenant_id" TEXT;

-- ============================================================ the rules

-- NULLABLE, AND NOTHING FILTERS ON IT. That is the whole design for now.
--
-- Every row written before this migration has no tenant, and every row
-- written by a caller that sends no X-Tenant-Id still will not. A WHERE
-- tenant_id = $1 added today would silently hide all of them, which is a
-- worse failure than not filtering at all: the rows are still there, still
-- billable, and invisible. The order is backfill, then filter, then NOT NULL.

-- A tenant is an opaque identifier from the platform, not free text. Bounded
-- so a malformed header cannot write a megabyte into every booking row, and
-- trimmed of the empty string so "no tenant" has exactly one representation
-- (NULL) rather than two.
ALTER TABLE booking
  ADD CONSTRAINT booking_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));
ALTER TABLE booking_group
  ADD CONSTRAINT booking_group_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));
ALTER TABLE booking_series
  ADD CONSTRAINT booking_series_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));
ALTER TABLE waitlist_entry
  ADD CONSTRAINT waitlist_entry_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));
ALTER TABLE walk_in_entry
  ADD CONSTRAINT walk_in_entry_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));
ALTER TABLE roster_change
  ADD CONSTRAINT roster_change_tenant_id_shape
    CHECK (tenant_id IS NULL OR (length(tenant_id) BETWEEN 1 AND 64));

-- The index the eventual filter will need, and that the backfill audit needs
-- today ("how many rows still have no tenant, per branch?").
--
-- PARTIAL on NOT NULL: while most rows are untenanted the index stays small,
-- and once the backfill completes it covers everything. An unpredicated index
-- would be mostly NULLs for the whole migration window.
CREATE INDEX IF NOT EXISTS booking_tenant_idx
  ON booking (tenant_id, branch_id, trading_day)
  WHERE tenant_id IS NOT NULL;
