-- Two rails the mobile contract can send and this enum could not hold.
--
-- booking-create.md §11 lists payment_method as WALLET, CARD, GOOGLE, APPLE,
-- OTHERS. Four of those already map onto payment_rail; GOOGLE and OTHERS did
-- not, and the §8 response has to give the method back exactly as it was
-- recorded. Folding GOOGLE into `card` would round-trip as CARD and put the
-- wrong method on a customer's receipt and in a dispute -- the value is
-- evidence about how money moved, not a display label.
--
-- ADD VALUE IF NOT EXISTS so a re-run is a no-op (CLAUDE.md 3: retry-safe).
-- Additive only: no existing row changes, and nothing reads these until the
-- mobile PATCH writes one.
--
-- NOTE ON TRANSACTIONS. ALTER TYPE ... ADD VALUE may not be used in the same
-- transaction that adds it. Prisma wraps a migration in one, so this file
-- only ADDS the labels; the first row using them is written by application
-- code in a later transaction, which is safe.
ALTER TYPE payment_rail ADD VALUE IF NOT EXISTS 'google_pay';
ALTER TYPE payment_rail ADD VALUE IF NOT EXISTS 'other';
