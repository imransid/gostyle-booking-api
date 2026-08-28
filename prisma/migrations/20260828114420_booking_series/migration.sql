-- CreateEnum
CREATE TYPE "recurrence_pattern" AS ENUM ('weekly', 'every_n_weeks', 'monthly_on_date', 'custom');

-- CreateEnum
CREATE TYPE "series_end_kind" AS ENUM ('never', 'on_date', 'after_count');

-- CreateEnum
CREATE TYPE "auto_confirm_rule" AS ENUM ('auto_confirm_on_schedule', 'ask_each_time', 'vip_standing');

-- CreateEnum
CREATE TYPE "series_status" AS ENUM ('active', 'paused', 'ended', 'completed');

-- CreateEnum
CREATE TYPE "occurrence_state" AS ENUM ('planned', 'materialised', 'needs_attention', 'skipped', 'detached');

-- CreateTable
CREATE TABLE "booking_series" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "anchor_day" DATE NOT NULL,
    "start_min" SMALLINT NOT NULL,
    "pattern" "recurrence_pattern" NOT NULL,
    "weekdays" SMALLINT[] DEFAULT ARRAY[]::SMALLINT[],
    "interval_weeks" SMALLINT,
    "day_of_month" SMALLINT,
    "custom_dates" DATE[] DEFAULT ARRAY[]::DATE[],
    "end_kind" "series_end_kind" NOT NULL DEFAULT 'never',
    "end_date" DATE,
    "end_count" SMALLINT,
    "auto_confirm_rule" "auto_confirm_rule" NOT NULL,
    "status" "series_status" NOT NULL DEFAULT 'active',
    "service_id" UUID NOT NULL,
    "preferred_staff_id" UUID,
    "baseline_price_fils" INTEGER NOT NULL DEFAULT 0,
    "grandfathered" BOOLEAN NOT NULL DEFAULT false,
    "materialised_through" DATE,
    "course_total_net_fils" INTEGER,
    "course_visits" SMALLINT,
    "course_drawn" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "series_occurrence" (
    "id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "index" SMALLINT NOT NULL,
    "planned_day" DATE NOT NULL,
    "planned_start_min" SMALLINT NOT NULL,
    "moved_from_day_of_month" SMALLINT,
    "state" "occurrence_state" NOT NULL DEFAULT 'planned',
    "booking_id" UUID,
    "alternatives" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "series_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "series_branch_idx" ON "booking_series"("branch_id", "anchor_day");

-- CreateIndex
CREATE INDEX "series_customer_idx" ON "booking_series"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "series_occurrence_booking_id_key" ON "series_occurrence"("booking_id");

-- CreateIndex
CREATE INDEX "occurrence_series_day_idx" ON "series_occurrence"("series_id", "planned_day");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_ordinal_uniq" ON "series_occurrence"("series_id", "index");

-- AddForeignKey
ALTER TABLE "series_occurrence" ADD CONSTRAINT "series_occurrence_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "booking_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================ the rules

-- The pattern payload must MATCH the pattern.
--
-- Four patterns, four shapes, and nothing stopping a weekly series from being
-- written with a day_of_month and no weekdays except this line. A series whose
-- payload does not match its kind expands to nothing, silently, and the first
-- anyone hears of it is a client asking why they have no appointments.
ALTER TABLE booking_series
  ADD CONSTRAINT series_payload_matches_pattern
    CHECK (
      CASE pattern
        WHEN 'weekly'          THEN array_length(weekdays, 1) BETWEEN 1 AND 7
        WHEN 'every_n_weeks'   THEN interval_weeks IS NOT NULL AND interval_weeks >= 1
        WHEN 'monthly_on_date' THEN day_of_month BETWEEN 1 AND 31
        WHEN 'custom'          THEN array_length(custom_dates, 1) >= 1
      END
    ),

  -- 0 is Sunday and 6 is Saturday, matching Date.getUTCDay and the domain's
  -- Weekday type. An 8 here would expand to a day that does not exist.
  ADD CONSTRAINT series_weekdays_in_range
    CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),

  -- The end condition carries exactly the field it needs, and no other. An
  -- end_count sitting on a never-ending series is a rule someone will later
  -- read as authoritative.
  ADD CONSTRAINT series_end_condition_is_coherent
    CHECK (
      CASE end_kind
        WHEN 'never'       THEN end_date IS NULL AND end_count IS NULL
        WHEN 'on_date'     THEN end_date IS NOT NULL AND end_count IS NULL
        WHEN 'after_count' THEN end_count IS NOT NULL AND end_count >= 1 AND end_date IS NULL
      END
    ),

  -- A series cannot end before it starts.
  ADD CONSTRAINT series_ends_after_it_starts
    CHECK (end_date IS NULL OR end_date >= anchor_day),

  -- The trading day is 10:00 to 22:00, per the grid. A start outside it is not
  -- a late appointment, it is a bug that would fail at materialisation every
  -- night forever.
  ADD CONSTRAINT series_start_inside_trading_day
    CHECK (start_min >= 600 AND start_min < 1320),

  -- A course is sold once, for a number of visits, at a price. All three or
  -- none: a course with visits but no money is a free course, and a course
  -- with money but no visit count can never reach a zero balance.
  ADD CONSTRAINT series_course_is_all_or_nothing
    CHECK (
      num_nonnulls(course_total_net_fils, course_visits) IN (0, 2)
    ),
  ADD CONSTRAINT series_course_visits_positive
    CHECK (course_visits IS NULL OR course_visits >= 1),
  ADD CONSTRAINT series_course_money_non_negative
    CHECK (course_total_net_fils IS NULL OR course_total_net_fils >= 0),

  -- The meter cannot read past empty, and cannot run at all without a course.
  ADD CONSTRAINT series_course_drawn_within_bounds
    CHECK (
      CASE WHEN course_visits IS NULL
           THEN course_drawn = 0
           ELSE course_drawn BETWEEN 0 AND course_visits
      END
    ),

  ADD CONSTRAINT series_baseline_non_negative
    CHECK (baseline_price_fils >= 0);

ALTER TABLE series_occurrence
  -- The ordinal is counted from the anchor, so it starts at zero.
  ADD CONSTRAINT occurrence_index_non_negative
    CHECK (index >= 0),

  ADD CONSTRAINT occurrence_start_inside_trading_day
    CHECK (planned_start_min >= 600 AND planned_start_min < 1320),

  -- THE STATE AND THE BOOKING MUST AGREE.
  --
  -- A materialised occurrence without a booking is a visit nobody will be
  -- given, and a needs-attention occurrence WITH one is a slot the engine
  -- just told us it could not find. Both are silent until the day itself,
  -- which is the worst possible moment to discover either.
  ADD CONSTRAINT occurrence_booking_matches_state
    CHECK (
      CASE state
        WHEN 'materialised'   THEN booking_id IS NOT NULL
        WHEN 'needs_attention' THEN booking_id IS NULL
        WHEN 'planned'        THEN booking_id IS NULL
        ELSE TRUE
      END
    ),

  -- Alternatives belong to an occurrence that needs attention. Anywhere else
  -- they are a stale list from a repair that has already happened.
  ADD CONSTRAINT occurrence_alternatives_only_when_stuck
    CHECK (alternatives IS NULL OR state = 'needs_attention'),

  ADD CONSTRAINT occurrence_moved_day_in_range
    CHECK (moved_from_day_of_month IS NULL
           OR moved_from_day_of_month BETWEEN 1 AND 31);

-- The nightly materialiser asks one question at 02:00: which live series need
-- topping up to the horizon?
--
-- PARTIAL on the live statuses. A series is 'active' or 'paused' for its
-- working life and 'ended'/'completed' forever after, so the index covers the
-- ones that can still move rather than every series the salon has ever sold.
-- Nulls first, because a series that has never been materialised is the most
-- urgent of all.
CREATE INDEX IF NOT EXISTS series_materialise_idx
  ON booking_series (materialised_through NULLS FIRST)
  WHERE status = 'active';

-- The repair worklist and the series panel both ask for the stuck ones.
CREATE INDEX IF NOT EXISTS occurrence_needs_attention_idx
  ON series_occurrence (series_id)
  WHERE state = 'needs_attention';

-- Reverse lookup: an occurrence from its booking, for the status listener.
-- Partial, because most occurrences are planned and carry no booking at all.
CREATE INDEX IF NOT EXISTS occurrence_booking_idx
  ON series_occurrence (booking_id)
  WHERE booking_id IS NOT NULL;
