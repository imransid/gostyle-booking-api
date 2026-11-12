-- Bookings -> POS open tickets: the constraints of 20261104120000_pos_ticket_sync,
-- made to fail on purpose (CLAUDE.md 5). A constraint never made to fail has
-- only been shown to parse.
--
--   psql "$DATABASE_URL" -f prisma/proof-pos-sync.sql
--
-- Runs in ONE transaction and rolls it back (deposit_ledger is append-only,
-- so nothing it wrote could be cleaned up otherwise). Each MUST FAIL test sits
-- in its own savepoint so its error does not abort the rest; a test that
-- prints no ERROR is a rule that does not hold.

\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set maya    '''22222222-2222-2222-2222-222222222222'''
\set bk      '''aaaaaaaa-0000-0000-0000-00000000f501'''
\set tenant  '''0190f0c1-1111-7000-8000-000000000001'''
\set ticket  '''0190f0c1-0000-7000-8000-0000000000aa'''
\set other   '''0190f0c1-0000-7000-8000-0000000000bb'''
\set ev1     '''0190f0c1-eeee-7000-8000-000000000001'''
\set ev2     '''0190f0c1-eeee-7000-8000-000000000002'''
\set ev3     '''0190f0c1-eeee-7000-8000-000000000003'''

BEGIN;

\echo ''
\echo '=== SETUP: a completed visit (AED 200 + 10 VAT), a AED 50 card deposit, three queued events ==='
INSERT INTO booking (id, tenant_id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, net_fils, tax_fils, discount_fils,
                     channel, updated_at)
VALUES (:bk, :tenant, 'GS-PROOF-P1', :branch, :dana, 'completed', 'deposit_paid',
        '2026-11-04', '2026-11-04 10:00:00+00', '2026-11-04 10:45:00+00',
        840, 45, 20000, 5000, 20000, 1000, 0, 'front_desk', now());
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', 5000, 'card', 'staff', :maya);
INSERT INTO pos_ticket_sync (id, event_id, event_at, booking_id, kind, booking_status)
VALUES (gen_random_uuid(), :ev1, '2026-11-04 09:50:00+00', :bk, 'open', 'checked_in'),
       (gen_random_uuid(), :ev2, '2026-11-04 10:00:00+00', :bk, 'status', 'in_service'),
       (gen_random_uuid(), :ev3, '2026-11-04 10:45:00+00', :bk, 'status', 'completed');

\echo ''
\echo '=== CHECK A: only the OLDEST unfinished row of the booking is claimable (expect 1 row: open checked_in) ==='
SELECT p.kind, p.booking_status
  FROM pos_ticket_sync p
 WHERE p.booking_id = :bk AND p.status = 'pending' AND p.next_attempt_at <= now()
   AND NOT EXISTS (
     SELECT 1 FROM pos_ticket_sync o
      WHERE o.booking_id = p.booking_id
        AND o.status IN ('pending', 'parked')
        AND (o.event_at, o.id) < (p.event_at, p.id));

\echo ''
\echo '=== CHECK B: a parked open still holds the rest back (expect 0 rows) ==='
UPDATE pos_ticket_sync SET status = 'parked', last_error_code = 'POS_LINE_CATALOG'
 WHERE event_id = :ev1;
SELECT p.kind, p.booking_status
  FROM pos_ticket_sync p
 WHERE p.booking_id = :bk AND p.status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM pos_ticket_sync o
      WHERE o.booking_id = p.booking_id
        AND o.status IN ('pending', 'parked')
        AND (o.event_at, o.id) < (p.event_at, p.id));

\echo ''
\echo '=== CHECK C: a re-delivered event enqueues nothing (expect INSERT 0 0) ==='
INSERT INTO pos_ticket_sync (id, event_id, event_at, booking_id, kind, booking_status)
VALUES (gen_random_uuid(), :ev1, now(), :bk, 'open', 'checked_in')
ON CONFLICT (event_id) DO NOTHING;

\echo ''
\echo '=== CHECK D: the till settles: applied_at_pos and a leftover, each with its VAT (expect INSERT 0 1 twice) ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail,
                            pos_transaction_id, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'applied_at_pos', -3000, 143, 'internal', :ticket, 'staff', :maya);
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail,
                            pos_transaction_id, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'refunded', -2000, 95, 'internal', :ticket, 'staff', :maya);
UPDATE booking SET pos_ticket_id = :ticket, pos_ticket_number = '#T-42' WHERE id = :bk;

\echo ''
\echo '=== TEST 1: a second draw-down for the same ticket. MUST FAIL (deposit_ledger_pos_applied_once). ==='
SAVEPOINT t1;
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail,
                            pos_transaction_id, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'applied_at_pos', -1, 0, 'internal', :ticket, 'staff', :maya);
ROLLBACK TO SAVEPOINT t1;

\echo ''
\echo '=== TEST 2: VAT on a capture. MUST FAIL (deposit_ledger_vat_fils_sane: only the till splits). ==='
SAVEPOINT t2;
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', 1000, 48, 'card', 'staff', :maya);
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '=== TEST 3: more VAT than the row moves. MUST FAIL (deposit_ledger_vat_fils_sane). ==='
SAVEPOINT t3;
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'refunded', -100, 101, 'internal', 'staff', :maya);
ROLLBACK TO SAVEPOINT t3;

\echo ''
\echo '=== TEST 4: negative VAT. MUST FAIL (deposit_ledger_vat_fils_sane). ==='
SAVEPOINT t4;
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, vat_fils, rail,
                            pos_transaction_id, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'applied_at_pos', -100, -1, 'internal', :other, 'staff', :maya);
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== TEST 5: a ticket id with no number. MUST FAIL (booking_pos_ticket_pair). ==='
SAVEPOINT t5;
UPDATE booking SET pos_ticket_number = NULL WHERE id = :bk;
ROLLBACK TO SAVEPOINT t5;

\echo ''
\echo '=== TEST 6: an open row for a completed visit. MUST FAIL (pos_ticket_sync_kind_matches). ==='
SAVEPOINT t6;
INSERT INTO pos_ticket_sync (id, event_id, event_at, booking_id, kind, booking_status)
VALUES (gen_random_uuid(), gen_random_uuid(), now(), :bk, 'open', 'completed');
ROLLBACK TO SAVEPOINT t6;

\echo ''
\echo '=== TEST 7: a status row nobody can send. MUST FAIL (pos_ticket_sync_kind_matches). ==='
SAVEPOINT t7;
INSERT INTO pos_ticket_sync (id, event_id, event_at, booking_id, kind, booking_status)
VALUES (gen_random_uuid(), gen_random_uuid(), now(), :bk, 'status', 'confirmed');
ROLLBACK TO SAVEPOINT t7;

\echo ''
\echo '=== TEST 8: parked without saying why. MUST FAIL (pos_ticket_sync_parked_says_why). ==='
SAVEPOINT t8;
UPDATE pos_ticket_sync SET status = 'parked', last_error_code = NULL WHERE event_id = :ev2;
ROLLBACK TO SAVEPOINT t8;

\echo ''
\echo '=== TEST 9: negative attempts. MUST FAIL (pos_ticket_sync_attempts_sane). ==='
SAVEPOINT t9;
UPDATE pos_ticket_sync SET attempts = -1 WHERE event_id = :ev2;
ROLLBACK TO SAVEPOINT t9;

\echo ''
\echo '=== TEST 10: a queue row for no booking. MUST FAIL (pos_ticket_sync_booking_id_fkey). ==='
SAVEPOINT t10;
INSERT INTO pos_ticket_sync (id, event_id, event_at, booking_id, kind, booking_status)
VALUES (gen_random_uuid(), gen_random_uuid(), now(), gen_random_uuid(), 'open', 'checked_in');
ROLLBACK TO SAVEPOINT t10;

\echo ''
\echo '=== CHECK E: the deposit balance after the settlement (expect 0) ==='
SELECT SUM(amount_fils) AS balance FROM deposit_ledger WHERE booking_id = :bk;

\echo ''
\echo '=== CHECK F: the worker claim and the safety net use their partial indexes ==='
SET LOCAL enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT id FROM pos_ticket_sync
 WHERE status = 'pending' AND next_attempt_at <= now()
 ORDER BY next_attempt_at LIMIT 20;
EXPLAIN (COSTS OFF)
SELECT id FROM booking
 WHERE status = 'completed' AND pos_ticket_id IS NOT NULL
   AND updated_at <= now() - interval '30 minutes'
 ORDER BY updated_at LIMIT 20;

ROLLBACK;

\echo ''
\echo '=== DONE: rolled back. Expect exactly ten ERROR lines above, TEST 1 to 10, in order. ==='
