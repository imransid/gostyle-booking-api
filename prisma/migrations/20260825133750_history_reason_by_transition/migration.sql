-- This is an empty migration.-- The old rule asked WHO did it. The right question is WHAT they did.
--
--   CHECK (actor_kind <> 'manager' OR reason IS NOT NULL)
--
-- That made a branch manager checking a customer in supply a reason, which
-- is ordinary desk work, not an override. Meanwhile a receptionist could
-- cancel a paid booking with no reason at all.
--
-- The transitions that genuinely need explaining are the ones that destroy
-- something: a cancellation, a no-show, a move. Those need a reason whoever
-- performs them. This mirrors `requiresReason` in the domain's transition
-- table, so the database and the code cannot drift apart.
ALTER TABLE booking_status_history
  DROP CONSTRAINT IF EXISTS bsh_manager_needs_reason;

ALTER TABLE booking_status_history
  ADD CONSTRAINT bsh_destructive_needs_reason
    CHECK (
      to_status NOT IN ('cancelled', 'no_show', 'rescheduled', 'skipped')
      OR reason IS NOT NULL
    );
