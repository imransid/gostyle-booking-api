-- AlterTable
ALTER TABLE "staff_reservation" ADD COLUMN     "claim_post_min" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "claim_pre_min" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "processing_from_min" SMALLINT,
ADD COLUMN     "processing_to_min" SMALLINT;

ALTER TABLE staff_reservation
  ADD CONSTRAINT staff_res_claims_sane
    CHECK (claim_pre_min >= 0 AND claim_post_min >= 0),
  ADD CONSTRAINT staff_res_processing_paired
    CHECK (num_nonnulls(processing_from_min, processing_to_min) <> 1),
  ADD CONSTRAINT staff_res_processing_ordered
    CHECK (processing_from_min IS NULL OR processing_to_min > processing_from_min);
