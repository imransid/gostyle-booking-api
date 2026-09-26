-- Mobile routine (series) booking: /v1/mobile-booking/series.
--
-- EIGHT NULLABLE COLUMNS ON booking_series AND NOTHING ELSE. No new table, no
-- new enum value, no change to any existing column, index or constraint. The
-- desk writes booking_series through its own code, which does not name these
-- columns, so every desk insert and update keeps working exactly as today.
--
-- NO DEFAULT AND NO BACKFILL. Every existing series was made at the desk, and
-- NULL says exactly that. `source = 'mobile'` marks a routine the app made;
-- everything the mobile path does differently hangs off it.
--
-- Plan: gostyle-customer-api docs/SERIES_BOOKING_AUDIT.md, E.2.
--
-- Written to be re-runnable (CLAUDE.md 3): ADD COLUMN IF NOT EXISTS, and each
-- CHECK inside a block that ignores "already exists".

-- AlterTable
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "frequency" TEXT;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "service_ids" UUID[];
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "payment_plan" TEXT;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "paused_until" DATE;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "pause_reason" TEXT;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "pause_note" TEXT;
ALTER TABLE "booking_series" ADD COLUMN IF NOT EXISTS "miss_streak_after" DATE;

-- The vocabularies, in raw SQL because Prisma cannot express a CHECK.
--
-- `source` is closed on purpose, as on booking_group: a second maker of
-- series should have to come here and say so.
DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_source_known
      CHECK (source IS NULL OR source = 'mobile');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- What the customer chose. The stored pattern of a mobile routine is always
-- CUSTOM (explicit dates), so this is the only place the choice survives.
DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_frequency_known
      CHECK (frequency IS NULL
             OR frequency IN ('daily', 'weekly', 'every_2_weeks', 'monthly', 'custom'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Every service of a session (D1). A mobile routine with no services would
-- book sessions with nothing in them.
--
-- SCOPED TO source = 'mobile', so it can never touch a desk insert, whatever
-- the desk's Prisma create sends for a list it does not set (NULL or '{}').
-- COALESCE because array_length of an empty array is NULL, and a CHECK that
-- evaluates to NULL passes (20260828115500 is that bug).
DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_mobile_has_services
      CHECK (source IS DISTINCT FROM 'mobile'
             OR COALESCE(array_length(service_ids, 1), 0) >= 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The three plans the app shows (D2). v1 only ever writes pay_at_salon; the
-- other two are allowed here so turning them on later needs no migration.
DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_payment_plan_known
      CHECK (payment_plan IS NULL
             OR payment_plan IN ('pay_at_salon', 'pay_as_you_go', 'upfront'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Why a routine is paused. `missed_twice` is the server's own (D5); the rest
-- are the app's picker, as the Figma lists it ('busy' is "Busy Period"). A
-- word nobody reads is refused.
DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_pause_reason_known
      CHECK (pause_reason IS NULL
             OR pause_reason IN ('travel', 'health', 'busy', 'budget', 'other',
                                 'missed_twice'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE booking_series
    ADD CONSTRAINT series_pause_note_length
      CHECK (pause_note IS NULL OR char_length(pause_note) BETWEEN 1 AND 200);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- NOT ADDED, ON PURPOSE: a CHECK tying paused_until to status = 'paused'.
--
-- The desk may resume a mobile routine with its own tools (plan R21). Its
-- resume sets status = 'active' and does not know paused_until exists, so
-- that CHECK would turn the desk's resume into a 500. Instead the mobile read
-- ignores paused_until, pause_reason and pause_note unless status = 'paused'.
-- prisma/proof-mobile-series.sql shows the desk's resume still works.
