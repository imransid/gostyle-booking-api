-- Journal sync on deposit_ledger: the append-only guard and the CHECKs, made
-- to fail on purpose (CLAUDE.md 5). A constraint never made to fail has only
-- been shown to parse.
--
--   psql "$DATABASE_URL" -f prisma/proof-journal.sql
--
-- Runs in ONE transaction and rolls it back: deposit_ledger is append-only,
-- so anything this wrote could never be cleaned up. Each MUST FAIL test sits
-- in its own savepoint so its error does not abort the rest; a test that
-- prints no ERROR is a rule that does not hold.

\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set maya    '''22222222-2222-2222-2222-222222222222'''
\set bk      '''aaaaaaaa-0000-0000-0000-00000000f001'''
\set tenant  '''0190f0c1-1111-7000-8000-000000000001'''
\set cap     '''e1111111-0000-0000-0000-00000000f001'''
\set fee     '''e1111111-0000-0000-0000-00000000f002'''

BEGIN;

\echo ''
\echo '=== SETUP: a confirmed booking, a card deposit captured, then forfeited ==='
INSERT INTO booking (id, tenant_id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, net_fils, tax_fils, discount_fils,
                     channel, updated_at)
VALUES (:bk, :tenant, 'GS-PROOF-J1', :branch, :dana, 'confirmed', 'deposit_paid',
        '2026-10-06', '2026-10-06 11:00:00+00', '2026-10-06 12:00:00+00',
        1020, 60, 10000, 10500, 10000, 500, 0, 'front_desk', now());
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail, actor_kind, actor_id)
VALUES (:cap, :bk, 'captured', 10500, 'card', 'staff', :maya);
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail, actor_kind)
VALUES (:fee, :bk, 'forfeited', -10500, 'internal', 'system');

\echo ''
\echo '=== CHECK A: a new row is pending and due, with no code having said so (expect 2 rows, pending) ==='
SELECT id, journal_sync_status, journal_attempts, journal_next_at IS NOT NULL AS due
  FROM deposit_ledger WHERE booking_id = :bk ORDER BY id;

\echo ''
\echo '=== CHECK B: the sync columns DO change: posted, with the platform entry (expect UPDATE 1) ==='
UPDATE deposit_ledger
   SET journal_sync_status = 'posted', journal_entry_id = gen_random_uuid(),
       journal_next_at = NULL, journal_attempts = 1
 WHERE id = :cap;

\echo ''
\echo '=== TEST 1: change the money. MUST FAIL (append-only). ==='
SAVEPOINT t1;
UPDATE deposit_ledger SET amount_fils = 1 WHERE id = :cap;
ROLLBACK TO SAVEPOINT t1;

\echo ''
\echo '=== TEST 2: smuggle a money change inside a sync update. MUST FAIL (append-only). ==='
SAVEPOINT t2;
UPDATE deposit_ledger SET journal_error = 'x', rail = 'cash' WHERE id = :fee;
ROLLBACK TO SAVEPOINT t2;

\echo ''
\echo '=== TEST 3: delete a ledger row. MUST FAIL (append-only). ==='
SAVEPOINT t3;
DELETE FROM deposit_ledger WHERE id = :fee;
ROLLBACK TO SAVEPOINT t3;

\echo ''
\echo '=== TEST 4: posted with no platform entry. MUST FAIL (deposit_ledger_journal_posted_has_entry). ==='
SAVEPOINT t4;
UPDATE deposit_ledger SET journal_sync_status = 'posted' WHERE id = :fee;
ROLLBACK TO SAVEPOINT t4;

\echo ''
\echo '=== TEST 5: pending with no next attempt. MUST FAIL (deposit_ledger_journal_pending_is_scheduled). ==='
SAVEPOINT t5;
UPDATE deposit_ledger SET journal_next_at = NULL WHERE id = :fee;
ROLLBACK TO SAVEPOINT t5;

\echo ''
\echo '=== TEST 6: negative attempts. MUST FAIL (deposit_ledger_journal_attempts_sane). ==='
SAVEPOINT t6;
UPDATE deposit_ledger SET journal_attempts = -1 WHERE id = :fee;
ROLLBACK TO SAVEPOINT t6;

\echo ''
\echo '=== CHECK C: the claim uses the partial index (expect deposit_ledger_journal_due_idx) ==='
SET LOCAL enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT id FROM deposit_ledger
 WHERE journal_sync_status = 'pending' AND journal_next_at <= now()
 ORDER BY journal_next_at LIMIT 20;

ROLLBACK;

\echo ''
\echo '=== DONE: rolled back. Expect exactly six ERROR lines above, TEST 1 to 6, in order. ==='
