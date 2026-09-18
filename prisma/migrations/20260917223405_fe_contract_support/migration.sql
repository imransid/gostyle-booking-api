-- CreateEnum
CREATE TYPE "booking_type" AS ENUM ('single', 'routine');

-- CreateEnum
CREATE TYPE "payment_method_kind" AS ENUM ('wallet', 'card', 'google', 'apple', 'others');

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "booking_type" "booking_type" NOT NULL DEFAULT 'single',
ADD COLUMN     "discount_fils" INTEGER,
ADD COLUMN     "net_fils" INTEGER,
ADD COLUMN     "payment_method" "payment_method_kind",
ADD COLUMN     "promo_code" TEXT,
ADD COLUMN     "series_id" UUID,
ADD COLUMN     "tax_fils" INTEGER;

-- AlterTable
ALTER TABLE "idempotency_key" ADD COLUMN     "customer_id" UUID;

-- CreateTable
CREATE TABLE "booking_product" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "price_fils" INTEGER NOT NULL,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "position" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_product_booking_idx" ON "booking_product"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_product_position_uniq" ON "booking_product"("booking_id", "position");

-- CreateIndex
CREATE INDEX "booking_series_idx" ON "booking"("series_id");

-- AddForeignKey
ALTER TABLE "booking_product" ADD CONSTRAINT "booking_product_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE UNIQUE INDEX IF NOT EXISTS "deposit_ledger_gateway_ref_key"
  ON "deposit_ledger" ("gateway_ref")
  WHERE "gateway_ref" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "event_outbox_unpublished_idx"
  ON "event_outbox" ("created_at")
  WHERE "published_at" IS NULL;

ALTER TABLE "booking_product"
  ADD CONSTRAINT "booking_product_money_sane"
  CHECK ("price_fils" >= 0 AND "quantity" > 0);