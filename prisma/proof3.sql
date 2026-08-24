\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set maya    '''22222222-2222-2222-2222-222222222222'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set mgr     '''66666666-6666-6666-6666-666666666666'''
\set bk      '''aaaaaaaa-0000-0000-0000-000000000001'''

\echo ''
\echo '=== SETUP: Dana confirmed, AED 240 deposit captured on the wallet ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-1042', :branch, :dana, 'confirmed', 'deposit_paid',
        '2026-08-21', '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00',
        900, 105, 48000, 24000, 'front_desk', now());
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail,
                            gateway_ref, actor_kind, actor_id)
VALUES ('e1111111-0000-0000-0000-000000000001', :bk, 'captured', 24000, 'wallet',
        'pi_abc123', 'staff', :maya);
\echo '--> captured +24000 fils'

\echo ''
\echo '=== TEST 1: a capture with a NEGATIVE amount. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', -24000, 'cash', 'staff', :maya);

\echo ''
\echo '=== TEST 2: a refund with a POSITIVE amount. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'refunded', 24000, 'manager', :mgr);

\echo ''
\echo '=== TEST 3: a zero-amount entry. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', 0, 'staff', :maya);

\echo ''
\echo '=== TEST 4: a reversal that names nothing. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'reversed', -24000, 'manager', :mgr);

\echo ''
\echo '=== TEST 5: cash with a gateway reference. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail,
                            gateway_ref, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', 10000, 'cash', 'pi_xyz', 'staff', :maya);

\echo ''
\echo '=== TEST 6: the gateway retries the SAME intent. MUST FAIL. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail,
                            gateway_ref, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'captured', 24000, 'wallet', 'pi_abc123', 'system', NULL);

\echo ''
\echo '=== TEST 7: EDIT a ledger row. MUST FAIL (append-only). ==='
UPDATE deposit_ledger SET amount_fils = 1 WHERE booking_id = :bk;

\echo ''
\echo '=== TEST 8: DELETE a ledger row. MUST FAIL (append-only). ==='
DELETE FROM deposit_ledger WHERE booking_id = :bk;

\echo ''
\echo '=== TEST 9: deposit applied at the till. MUST PASS. ==='
INSERT INTO deposit_ledger (id, booking_id, entry_type, amount_fils, rail,
                            pos_transaction_id, actor_kind, actor_id)
VALUES ('e1111111-0000-0000-0000-000000000002', :bk, 'applied_at_pos', -24000, 'internal',
        'POS-88213', 'staff', :maya);
\echo '--> applied -24000 fils'

\echo ''
\echo '=== TEST 10: the balance is just SUM(amount_fils) ==='
SELECT SUM(amount_fils) AS balance_fils,
       (SUM(amount_fils) / 100.0)::numeric(10,2) AS balance_aed
  FROM deposit_ledger WHERE booking_id = :bk;

\echo ''
\echo '=== TEST 11: history where nothing moved. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'confirmed', 'staff', :maya);

\echo ''
\echo '=== TEST 12: system transition WITH a human actor. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'no_show', 'system', :maya);

\echo ''
\echo '=== TEST 13: manager override with no reason. MUST FAIL. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'cancelled', 'manager', :mgr);

\echo ''
\echo '=== TEST 14: the auto no-show at start+30. MUST PASS. ==='
INSERT INTO booking_status_history (id, booking_id, from_status, to_status, reason,
                                    metadata, actor_kind, actor_id)
VALUES (gen_random_uuid(), :bk, 'confirmed', 'no_show', 'grace elapsed',
        '{"grace_min": 15, "fired_at_minute": 930}'::jsonb, 'system', NULL);
\echo '--> logged, attributed to system'

\echo ''
\echo '=== TEST 15: outbox row written with the state change. MUST PASS. ==='
INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload)
VALUES ('f1111111-0000-0000-0000-000000000001', 'booking', :bk, 'booking.confirmed',
        '{"code":"GS-1042","depositFils":24000}'::jsonb);

\echo ''
\echo '=== TEST 16: the relay finds unpublished events ==='
SELECT event_type, published_at FROM event_outbox WHERE published_at IS NULL;

\echo ''
\echo '=== TEST 17: relay publishes, stamps the row ==='
UPDATE event_outbox SET published_at = now()
 WHERE id = 'f1111111-0000-0000-0000-000000000001';
SELECT count(*) AS still_unpublished FROM event_outbox WHERE published_at IS NULL;

\echo ''
\echo '=== TEST 18: published BEFORE created. MUST FAIL. ==='
INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload,
                          created_at, published_at)
VALUES (gen_random_uuid(), 'booking', :bk, 'booking.cancelled', '{}'::jsonb,
        now(), now() - interval '1 hour');

\echo ''
\echo '=== TEST 19: first confirm request with an idempotency key. MUST PASS. ==='
INSERT INTO idempotency_key (key, operation, request_hash, response_status,
                             response_body, booking_id, expires_at)
VALUES ('idem-9f2c', 'POST /bookings', 'sha256:req1', 201,
        '{"code":"GS-1042"}'::jsonb, :bk, now() + interval '24 hours');

\echo ''
\echo '=== TEST 20: the client retries the SAME key. MUST FAIL. ==='
INSERT INTO idempotency_key (key, operation, request_hash, expires_at)
VALUES ('idem-9f2c', 'POST /bookings', 'sha256:req1', now() + interval '24 hours');

\echo ''
\echo '=== TEST 21: a booking with money cannot be deleted. MUST FAIL. ==='
DELETE FROM booking WHERE id = :bk;

\echo ''
\echo '=== DONE ==='
