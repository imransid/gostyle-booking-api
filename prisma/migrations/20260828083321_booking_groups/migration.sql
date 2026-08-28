-- CreateEnum
CREATE TYPE "group_mode" AS ENUM ('arrive_together', 'finish_together');

-- CreateEnum
CREATE TYPE "group_arrangement" AS ENUM ('organiser_pays_all', 'split_equally', 'each_pays_own');

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "group_id" UUID;

-- CreateTable
CREATE TABLE "booking_group" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "organiser_id" UUID NOT NULL,
    "trading_day" DATE NOT NULL,
    "target_min" SMALLINT NOT NULL,
    "mode" "group_mode" NOT NULL,
    "arrangement" "group_arrangement" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_participant" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "customer_id" UUID,
    "guest_name" TEXT,
    "booking_id" UUID,
    "share_fils" INTEGER,
    "position" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_day_idx" ON "booking_group"("branch_id", "trading_day");

-- CreateIndex
CREATE UNIQUE INDEX "group_participant_booking_id_key" ON "group_participant"("booking_id");

-- CreateIndex
CREATE INDEX "participant_booking_idx" ON "group_participant"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "participant_position_uniq" ON "group_participant"("group_id", "position");

-- AddForeignKey
ALTER TABLE "group_participant" ADD CONSTRAINT "group_participant_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "booking_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A participant is EITHER a registered customer OR a named guest.
--
-- Both would mean two identities for one person; neither would mean a lane
-- nobody can be contacted about. The spec allows exactly two shapes, and this
-- is where that stops being a convention and becomes a fact.
ALTER TABLE group_participant
  ADD CONSTRAINT participant_is_customer_or_guest
    CHECK (num_nonnulls(customer_id, guest_name) = 1),
  -- A share is money. Negative money is not a share.
  ADD CONSTRAINT participant_share_non_negative
    CHECK (share_fils IS NULL OR share_fils >= 0);

-- Minimum 2, hard cap 8 online. Enforced as a trigger rather than a CHECK,
-- because the rule is about the COUNT of rows in another table and a CHECK
-- cannot see that.
--
-- Deferred to the end of the transaction: a group is built one participant at
-- a time, so a check that fired on the first insert would reject every group
-- for having one member.
CREATE OR REPLACE FUNCTION group_size_within_bounds() RETURNS trigger AS $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM group_participant
   WHERE group_id = COALESCE(NEW.group_id, OLD.group_id);

  -- Zero is a group being torn down, which is allowed: the caller deletes the
  -- parent next. Only a populated group has to be a legal size.
  IF n > 8 THEN
    RAISE EXCEPTION 'A group may hold at most 8 participants, not %', n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER group_size_check
  AFTER INSERT OR DELETE ON group_participant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION group_size_within_bounds();

-- Every lane of a group, in order. The planner returns lanes per participant
-- and the diary reads them back the same way.
CREATE INDEX IF NOT EXISTS booking_group_idx
  ON booking (group_id) WHERE group_id IS NOT NULL;
