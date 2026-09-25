/**
 * What a CUSTOMER token may do to a booking, as opposed to staff.
 *
 * The lifecycle routes (POST /v1/bookings/:id/cancel, reschedule, and the
 * rest) are shared by the desk and the app. The state machine already knows
 * which transitions a customer may make; what it never asked is WHOSE
 * booking it is. So any customer who learned a booking id could cancel it,
 * and could send `nowMs` to choose the clock the refund band is measured
 * against.
 *
 * STAFF ARE UNCHANGED, on purpose. The desk acts on other people's bookings
 * all day; its limits (branch, role) live where they always have. These two
 * rules apply to a customer token and to nothing else.
 */

/**
 * May this actor act on a booking owned by `bookingCustomerId`?
 *
 * Both ids folded the same way before they get here (the column holds the
 * folded id). A booking with no owner, or one that does not exist, belongs to
 * no customer.
 */
export function mayActOn(input: {
  readonly actorKind: string;
  readonly actorId: string;
  readonly bookingCustomerId: string | null;
}): boolean {
  if (input.actorKind !== 'customer') return true;
  return (
    input.bookingCustomerId !== null &&
    input.bookingCustomerId === input.actorId
  );
}

/**
 * The clock a request may set.
 *
 * `nowMs` exists so the desk and the tests can replay a moment. A customer
 * choosing the time a cancellation happened is choosing their own refund,
 * so for a customer it is dropped and the server's clock is used.
 */
export function clockFor(
  actorKind: string,
  nowMs: number | undefined,
): number | undefined {
  return actorKind === 'customer' ? undefined : nowMs;
}
