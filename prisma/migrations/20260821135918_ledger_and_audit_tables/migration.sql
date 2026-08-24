-- CreateEnum
CREATE TYPE "ledger_entry_type" AS ENUM ('captured', 'applied_at_pos', 'refunded', 'partially_refunded', 'forfeited', 'reversed', 'goodwill', 'course_draw');

-- CreateEnum
CREATE TYPE "payment_rail" AS ENUM ('wallet', 'card', 'apple_pay', 'cash', 'link', 'internal');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('customer', 'staff', 'manager', 'system');

-- CreateTable
CREATE TABLE "deposit_ledger" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "entry_type" "ledger_entry_type" NOT NULL,
    "amount_fils" INTEGER NOT NULL,
    "rail" "payment_rail",
    "gateway_ref" TEXT,
    "pos_transaction_id" TEXT,
    "linked_entry_id" UUID,
    "reason" TEXT,
    "actor_kind" "actor_kind" NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_status_history" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "from_status" "booking_status",
    "to_status" "booking_status" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "actor_kind" "actor_kind" NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" SMALLINT,
    "response_body" JSONB,
    "booking_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "deposit_ledger_booking_idx" ON "deposit_ledger"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "booking_status_history_booking_idx" ON "booking_status_history"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "event_outbox_aggregate_idx" ON "event_outbox"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "idempotency_key_expiry_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_ledger" ADD CONSTRAINT "deposit_ledger_linked_entry_id_fkey" FOREIGN KEY ("linked_entry_id") REFERENCES "deposit_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Step 3 constraints: what Prisma cannot express.
-- ============================================================

ALTER TABLE deposit_ledger
  ADD CONSTRAINT deposit_ledger_never_zero CHECK (amount_fils <> 0),
  ADD CONSTRAINT deposit_ledger_sign CHECK (
    CASE entry_type
      WHEN 'captured'           THEN amount_fils > 0
      WHEN 'goodwill'           THEN amount_fils > 0
      WHEN 'applied_at_pos'     THEN amount_fils < 0
      WHEN 'refunded'           THEN amount_fils < 0
      WHEN 'partially_refunded' THEN amount_fils < 0
      WHEN 'forfeited'          THEN amount_fils < 0
      WHEN 'course_draw'        THEN amount_fils < 0
      WHEN 'reversed'           THEN TRUE
    END
  ),
  ADD CONSTRAINT deposit_ledger_reversal_linked CHECK (
    (entry_type IN ('reversed', 'partially_refunded')) = (linked_entry_id IS NOT NULL)
  ),
  ADD CONSTRAINT deposit_ledger_cash_has_no_gateway_ref CHECK (
    rail <> 'cash' OR gateway_ref IS NULL
  );

CREATE UNIQUE INDEX deposit_ledger_gateway_ref_key
  ON deposit_ledger(gateway_ref) WHERE gateway_ref IS NOT NULL;

ALTER TABLE booking_status_history
  ADD CONSTRAINT bsh_actually_moved CHECK (from_status IS DISTINCT FROM to_status),
  ADD CONSTRAINT bsh_system_has_no_actor CHECK ((actor_kind = 'system') = (actor_id IS NULL)),
  ADD CONSTRAINT bsh_manager_needs_reason CHECK (actor_kind <> 'manager' OR reason IS NOT NULL);

ALTER TABLE event_outbox
  ADD CONSTRAINT outbox_published_after_created CHECK (
    published_at IS NULL OR published_at >= created_at
  ),
  ADD CONSTRAINT outbox_attempts_sane CHECK (attempts >= 0);

CREATE INDEX event_outbox_unpublished_idx
  ON event_outbox(created_at) WHERE published_at IS NULL;

ALTER TABLE idempotency_key
  ADD CONSTRAINT idem_expires_after_created CHECK (expires_at > created_at);

-- APPEND-ONLY, enforced by the database.
-- A ledger you can UPDATE is not a ledger.
CREATE OR REPLACE FUNCTION gs_refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'table % is append-only; % is not allowed. Write a linked correcting row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deposit_ledger_append_only
  BEFORE UPDATE OR DELETE ON deposit_ledger
  FOR EACH ROW EXECUTE FUNCTION gs_refuse_mutation();

CREATE TRIGGER booking_status_history_append_only
  BEFORE UPDATE OR DELETE ON booking_status_history
  FOR EACH ROW EXECUTE FUNCTION gs_refuse_mutation();
