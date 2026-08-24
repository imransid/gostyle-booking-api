-- This is an empty migration.-- Human-readable booking reference, e.g. GS-1042.
--
-- A sequence rather than MAX(code)+1, because two desks confirming in the
-- same instant must get different numbers. A sequence hands out values
-- outside transaction isolation, so it cannot collide.
--
-- Gaps are expected and harmless: a rolled-back confirm burns a number.
-- Nobody counts bookings by reading the codes.
CREATE SEQUENCE IF NOT EXISTS booking_code_seq START 1000;
