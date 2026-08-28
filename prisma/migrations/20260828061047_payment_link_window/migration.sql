-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "link_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "link_reminded_at" TIMESTAMPTZ(6);
