\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\pset pager off

-- booking_item.package_id / package_name / package_seq, made to fail on
-- purpose (CLAUDE.md 5).
--
--   psql <throwaway db> -X -f prisma/proof-booking-item-package.sql
--
-- Every MUST FAIL prints its error in order; a missing error is a constraint
-- that does not hold. The MUST SUCCEED lines are the controls.
--
-- NOTHING HERE OUTLIVES THE RUN. The tests are one transaction, rolled
-- back; the second run of the migration is its own transaction, rolled back
-- too (Postgres DDL is transactional, so it still proves the re-run is a
-- no-op). And it refuses any database whose name does not say it is a
-- throwaway one, so it can never add the columns to a real database outside
-- _prisma_migrations.

SELECT current_database() ~ '(proof|test)' AS throwaway \gset
\if :throwaway
\else
  \echo 'REFUSING: run this against a throwaway database (its name must contain proof or test).'
  \quit
\endif

\set branch  '''11111111-1111-1111-1111-111111111111'''
\set sara    '''22222222-2222-4222-8222-222222222222'''
\set maya    '''33333333-3333-4333-8333-333333333333'''
\set bk      '''cccccccc-0000-4000-8000-000000000018'''
\set cut     '''66666666-6666-6666-6666-666666666660'''
\set beard   '''66666666-6666-6666-6666-666666666662'''
\set groom   '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'''

\echo ''
\echo '=== TEST 0: the constraint is the one the migration means. MUST SHOW all three columns. ==='
SELECT pg_get_constraintdef(oid) AS booking_item_package_named
  FROM pg_constraint WHERE conname = 'booking_item_package_named';

BEGIN;

\echo ''
\echo '=== SETUP: GS-PROOF-PKG, Sara''s, confirmed, AED 370 ==='
INSERT INTO booking (id, code, branch_id, customer_id, status, payment_status,
                     trading_day, start_at, end_at, start_minute, duration_min,
                     price_fils, deposit_fils, channel, updated_at)
VALUES (:bk, 'GS-PROOF-PKG', :branch, :sara, 'confirmed', 'none_required',
        '2026-10-19', '2026-10-19 06:00:00+00', '2026-10-19 07:00:00+00',
        600, 60, 37000, 0, 'mobile', now());

\echo ''
\echo '=== TEST 1: a hand-picked service, no package. MUST SUCCEED. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id)
VALUES (gen_random_uuid(), :bk, :cut, 'Haircut', 'styling', '', 18500, 30, 0,
        :maya);

\echo ''
\echo '=== TEST 2: a part of Groom and Go, its first sale, named. MUST SUCCEED. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id,
                          package_id, package_name, package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        1, :maya, :groom, 'Groom and Go', 0);

\echo ''
\echo '=== TEST 3: a package id with no name: a blank on the receipt. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id, package_id,
                          package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        2, :maya, :groom, 0);

\echo ''
\echo '=== TEST 4: a name with no id: a package nobody can find. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id, package_name,
                          package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        3, :maya, 'Groom and Go', 0);

\echo ''
\echo '=== TEST 5: an id and a blank name. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id,
                          package_id, package_name, package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        4, :maya, :groom, '   ', 0);

\echo ''
\echo '=== TEST 6: a package with no sale number: two sales would read as one. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id,
                          package_id, package_name)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        5, :maya, :groom, 'Groom and Go');

\echo ''
\echo '=== TEST 7: a sale number below zero. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id,
                          package_id, package_name, package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        6, :maya, :groom, 'Groom and Go', -1);

\echo ''
\echo '=== TEST 8: a sale number on a hand-picked line. MUST FAIL. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id, package_seq)
VALUES (gen_random_uuid(), :bk, :cut, 'Haircut', 'styling', '', 18500, 30, 7,
        :maya, 0);

\echo ''
\echo '=== TEST 9: the same package sold a second time. MUST SUCCEED. ==='
INSERT INTO booking_item (id, booking_id, service_id, service_name,
                          resource_type, required_skill, price_fils,
                          duration_min, position, staff_id,
                          package_id, package_name, package_seq)
VALUES (gen_random_uuid(), :bk, :beard, 'Beard trim', 'styling', '', 18500, 30,
        8, :maya, :groom, 'Groom and Go', 1);

\echo ''
\echo '=== RESULT: the three good lines, nothing else ==='
SELECT position, service_name, price_fils, package_name, package_seq
  FROM booking_item WHERE booking_id = :bk ORDER BY position;

ROLLBACK;

\echo ''
\echo '=== TEST 10: the migration, run a second time. MUST SUCCEED, silently (rolled back). ==='
BEGIN;
\i prisma/migrations/20261018120000_booking_item_package/migration.sql
ROLLBACK;
