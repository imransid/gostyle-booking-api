\set ON_ERROR_STOP off
\pset pager off

-- notification_delivery, made to fail on purpose (CLAUDE.md 5).
--
--   docker exec -i <postgres> psql -U gostyle -d <db> < prisma/proof-reminder-delivery.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls.

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set bk      '''aaaaaaaa-0000-4000-8000-000000000001'''
\set late    '''aaaaaaaa-0000-4000-8000-000000000002'''
\set evt     '''0192aaaa-0000-7000-8000-000000000001'''

\echo ''
\echo '=== SETUP: GS-1050, Sunday 11 October 10:00 Dhaka (04:00 UTC), confirmed ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-1050', :branch, :sara, 'confirmed', 'deposit_paid',
        '2026-10-11', '2026-10-11 04:00:00+00', '2026-10-11 05:45:00+00',
        600, 105, 48000, 24000, 'mobile', now());

\echo '--> the 24h reminder, claimed: one push row, one email row'
INSERT INTO notification_delivery (id, source_event_id, channel, event_type,
            booking_id, customer_id, scheduled_for, expires_at, updated_at)
VALUES (gen_random_uuid(), :evt, 'push', 'reminder.confirm_24h', :bk, :sara,
        '2026-10-11 04:00:00+00', '2026-10-11 01:00:00+00', now()),
       (gen_random_uuid(), :evt, 'email', 'reminder.confirm_24h', :bk, :sara,
        '2026-10-11 04:00:00+00', '2026-10-11 01:00:00+00', now());

\echo ''
\echo '=== TEST 1: the same event relayed twice, push again. MUST FAIL. ==='
INSERT INTO notification_delivery (id, source_event_id, channel, event_type,
            booking_id, customer_id, scheduled_for, expires_at, updated_at)
VALUES (gen_random_uuid(), :evt, 'push', 'reminder.confirm_24h', :bk, :sara,
        '2026-10-11 04:00:00+00', '2026-10-11 01:00:00+00', now());

\echo ''
\echo '=== TEST 2: ... and ON CONFLICT DO NOTHING, as the listener writes it: 0 rows. MUST SUCCEED. ==='
INSERT INTO notification_delivery (id, source_event_id, channel, event_type,
            booking_id, customer_id, scheduled_for, expires_at, updated_at)
VALUES (gen_random_uuid(), :evt, 'push', 'reminder.confirm_24h', :bk, :sara,
        '2026-10-11 04:00:00+00', '2026-10-11 01:00:00+00', now())
ON CONFLICT DO NOTHING;

\echo ''
\echo '=== TEST 3: marked sent with no time. MUST FAIL. ==='
UPDATE notification_delivery SET status = 'sent'
 WHERE source_event_id = :evt AND channel = 'push';

\echo ''
\echo '=== TEST 4: a send time on a row that was not sent. MUST FAIL. ==='
UPDATE notification_delivery SET sent_at = now()
 WHERE source_event_id = :evt AND channel = 'push';

\echo ''
\echo '=== TEST 5: skipped without saying why. MUST FAIL. ==='
UPDATE notification_delivery SET status = 'skipped'
 WHERE source_event_id = :evt AND channel = 'email';

\echo ''
\echo '=== TEST 6: a negative attempt count. MUST FAIL. ==='
UPDATE notification_delivery SET attempts = -1
 WHERE source_event_id = :evt AND channel = 'email';

\echo ''
\echo '=== TEST 7: a delivery for a booking that does not exist. MUST FAIL. ==='
INSERT INTO notification_delivery (id, source_event_id, channel, event_type,
            booking_id, customer_id, scheduled_for, expires_at, updated_at)
VALUES (gen_random_uuid(), gen_random_uuid(), 'push', 'reminder.confirm_24h',
        gen_random_uuid(), :sara, now(), now(), now());

\echo ''
\echo '=== TEST 8: sent with its time, skipped with its reason. MUST SUCCEED. ==='
UPDATE notification_delivery SET status = 'sent', sent_at = now(), provider_ref = 'devices=1'
 WHERE source_event_id = :evt AND channel = 'push';
UPDATE notification_delivery SET status = 'skipped', skip_reason = 'no_email'
 WHERE source_event_id = :evt AND channel = 'email';
SELECT channel, status, skip_reason, provider_ref FROM notification_delivery
 WHERE source_event_id = :evt ORDER BY channel;

\echo ''
\echo '=== TEST 9: the dispatcher''s due query reads the partial index. MUST SHOW notification_delivery_due_idx. ==='
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT id FROM notification_delivery
 WHERE status = 'pending' AND next_attempt_at <= now()
 ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED;
RESET enable_seqscan;

\echo ''
\echo '=== SETUP: GS-1051 moved to two hours from now; a move clears all three stamps ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:late, 'GS-1051', :branch, :sara, 'confirmed', 'deposit_paid',
        (now() + interval '2 hours')::date, now() + interval '2 hours',
        now() + interval '3 hours', 0, 60, 30000, 0, 'mobile', now());

\echo ''
\echo '=== TEST 10: the 3h claim, as reminder.repository builds it, on that booking. MUST RETURN 0 ROWS. ==='
\echo '    (the bug: it used to claim, stamp reminded_3h_at, and send nothing)'
SELECT id FROM booking
 WHERE reminded_3h_at IS NULL
   AND reminded_24h_at IS NOT NULL
   AND status = ANY(ARRAY['confirmed', 'pending_payment']::booking_status[])
   AND start_at <= now() + interval '3 hours'
   AND id = :late;

\echo ''
\echo '=== TEST 11: the 24h claim takes it first, then the 3h claim can. MUST RETURN 1 ROW EACH. ==='
UPDATE booking SET reminded_24h_at = now()
 WHERE id IN (SELECT id FROM booking
               WHERE reminded_24h_at IS NULL
                 AND status = ANY(ARRAY['confirmed', 'pending_payment']::booking_status[])
                 AND start_at <= now() + interval '24 hours'
                 AND id = :late
               FOR UPDATE SKIP LOCKED)
RETURNING code, 'claimed 24h' AS step;
SELECT code, 'claimable at 3h' AS step FROM booking
 WHERE reminded_3h_at IS NULL
   AND reminded_24h_at IS NOT NULL
   AND status = ANY(ARRAY['confirmed', 'pending_payment']::booking_status[])
   AND start_at <= now() + interval '3 hours'
   AND id = :late;

\echo ''
\echo '=== CLEANUP ==='
DELETE FROM notification_delivery WHERE booking_id IN (:bk, :late);
DELETE FROM booking WHERE id IN (:bk, :late);
SELECT count(*) AS remaining FROM booking WHERE id IN (:bk, :late);
