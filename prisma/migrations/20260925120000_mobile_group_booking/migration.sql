-- Mobile group booking: POST /v1/mobile-booking/group.
--
-- FOUR NULLABLE COLUMNS AND NOTHING ELSE. No new table, no new enum value,
-- no change to any existing column, index or constraint. The business web
-- reads booking_group and group_participant and never selects these, so it
-- cannot notice them.
--
-- NO DEFAULT AND NO BACKFILL. Every existing group was made at the desk, and
-- NULL says exactly that. `source = 'mobile'` is what marks a party the app
-- made; everything the mobile read does differently hangs off it.
--
-- Written to be re-runnable (CLAUDE.md 3): ADD COLUMN IF NOT EXISTS, and each
-- CHECK inside a block that ignores "already exists".

-- AlterTable
ALTER TABLE "booking_group" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "booking_group" ADD COLUMN IF NOT EXISTS "deposit_percent" SMALLINT;

-- AlterTable
ALTER TABLE "group_participant" ADD COLUMN IF NOT EXISTS "age_group" TEXT;
ALTER TABLE "group_participant" ADD COLUMN IF NOT EXISTS "client_ref" SMALLINT;

-- The vocabularies, in raw SQL because Prisma cannot express a CHECK.
--
-- `source` is closed on purpose: a second maker of groups should have to
-- come here and say so, not write a new word nobody reads.
DO $$
BEGIN
  ALTER TABLE booking_group
    ADD CONSTRAINT booking_group_source_known
      CHECK (source IS NULL OR source = 'mobile');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- A percent is 0 to 100. Anything else is a bug upstream, not a deposit.
DO $$
BEGIN
  ALTER TABLE booking_group
    ADD CONSTRAINT booking_group_deposit_percent_range
      CHECK (deposit_percent IS NULL OR deposit_percent BETWEEN 0 AND 100);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The two age groups the app sends. The child price is worked out from this
-- column, so a third word would silently charge full price.
DO $$
BEGIN
  ALTER TABLE group_participant
    ADD CONSTRAINT participant_age_group_known
      CHECK (age_group IS NULL OR age_group IN ('adult', 'child'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE group_participant
    ADD CONSTRAINT participant_client_ref_non_negative
      CHECK (client_ref IS NULL OR client_ref >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
