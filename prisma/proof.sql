\set ON_ERROR_STOP off
\pset pager off

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set maya    '''22222222-2222-2222-2222-222222222222'''
\set anya    '''33333333-3333-3333-3333-333333333333'''
\set dana    '''44444444-4444-4444-4444-444444444444'''
\set reem    '''55555555-5555-5555-5555-555555555555'''

\echo ''
\echo '=== SETUP: Dana books Maya, Friday 15:00 to 16:45 ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'GS-1042', :branch, :dana,
        'confirmed', 'deposit_paid',
        '2026-08-21', '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00',
        900, 105, 48000, 24000, 'front_desk', now());

INSERT INTO booking_item (id, booking_id, service_id, service_name, resource_type,
                          required_skill, price_fils, duration_min, position, staff_id)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        gen_random_uuid(), 'Full color and gloss', 'color', 'color',
        48000, 105, 0, :maya);

INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);
\echo '--> inserted'

\echo ''
\echo '=== TEST 1: Desk 2 tries the SAME slot on Maya. MUST FAIL. ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 'GS-1043', :branch, :reem,
        'confirmed', 'unpaid', '2026-08-21',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105, 48000, 0, 'front_desk', now());
INSERT INTO booking_item (id, booking_id, service_id, service_name, resource_type,
                          required_skill, price_fils, duration_min, position, staff_id)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
        gen_random_uuid(), 'Full color and gloss', 'color', 'color', 48000, 105, 0, :maya);
INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);

\echo ''
\echo '=== TEST 2: PARTIAL overlap on Maya, 16:00 to 17:00. MUST FAIL. ==='
INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 12:00:00+00', '2026-08-21 13:00:00+00', 960, 60);

\echo ''
\echo '=== TEST 3: Anya, SAME time, different professional. MUST PASS. ==='
INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, :anya, '2026-08-21', 'active',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);

\echo ''
\echo '=== TEST 4: Maya, back-to-back at 16:45 exactly. MUST PASS ([) bound). ==='
INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 12:45:00+00', '2026-08-21 13:30:00+00', 1005, 45);

\echo ''
\echo '=== TEST 5: Dana cancels. blocking -> false. Slot frees. ==='
UPDATE staff_reservation SET blocking = FALSE
 WHERE booking_item_id = 'bbbbbbbb-0000-0000-0000-000000000001';
UPDATE booking SET status = 'cancelled' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

INSERT INTO staff_reservation (id, booking_item_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);
\echo '--> the freed slot was taken'

\echo ''
\echo '=== TEST 6: a HOLD blocks a booking on the same staff+time. MUST FAIL. ==='
INSERT INTO hold (id, branch_id, customer_id, trading_day, feasibility_token, expires_at)
VALUES ('cccccccc-0000-0000-0000-000000000001', :branch, :reem, '2026-08-21',
        'sha256:abc', now() + interval '10 minutes');
INSERT INTO staff_reservation (id, hold_id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', :branch, :anya, '2026-08-21', 'active',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);

\echo ''
\echo '=== TEST 7: two colour stations, both bookable at once. MUST PASS. ==='
INSERT INTO resource_reservation (id, booking_item_id, branch_id, resource_type, trading_day,
                                  start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', :branch, 'color', '2026-08-21',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105),
       (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, 'color', '2026-08-21',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);
\echo '--> both accepted (capacity is counted, not excluded)'

\echo ''
\echo '=== TEST 8: same PINNED chair C1 twice at once. MUST FAIL. ==='
INSERT INTO resource_reservation (id, booking_item_id, branch_id, resource_type, resource_unit_id,
                                  trading_day, start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', :branch, 'color',
        'dddddddd-0000-0000-0000-0000000000c1', '2026-08-21',
        '2026-08-21 11:00:00+00', '2026-08-21 12:45:00+00', 900, 105);
INSERT INTO resource_reservation (id, booking_item_id, branch_id, resource_type, resource_unit_id,
                                  trading_day, start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000002', :branch, 'color',
        'dddddddd-0000-0000-0000-0000000000c1', '2026-08-21',
        '2026-08-21 11:30:00+00', '2026-08-21 12:00:00+00', 930, 30);

\echo ''
\echo '=== TEST 9: a reservation owned by NEITHER booking nor hold. MUST FAIL. ==='
INSERT INTO staff_reservation (id, branch_id, staff_id, trading_day, kind,
                               start_at, end_at, start_minute, duration_min)
VALUES (gen_random_uuid(), :branch, :maya, '2026-08-21', 'active',
        '2026-08-21 20:00:00+00', '2026-08-21 20:30:00+00', 1440, 30);

\echo ''
\echo '=== DONE ==='
