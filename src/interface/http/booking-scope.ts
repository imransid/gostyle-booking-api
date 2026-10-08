import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Actor } from '../../auth/actor';
import {
  scopeVerdict,
  staffScopeMode,
  type ScopeActor,
  type ScopeMode,
  type ScopeRefusal,
} from '@domain/booking/booking-scope';
import {
  BookingScopeRepository,
  type ScopedBookingRow,
} from '@infrastructure/persistence/booking-scope.repository';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/** STAFF_SCOPE_V1: off, log or on. domain/booking/booking-scope.ts says what each does. */
export const STAFF_SCOPE_V1 = (): ScopeMode =>
  staffScopeMode(process.env.STAFF_SCOPE_V1);

/**
 * How a route names the booking it acts on.
 *
 * A code only where the route really takes one (late-capture). The lookup
 * matches exactly what that route's handler matches, so the row checked is
 * the row acted on: see booking-scope.repository.ts.
 */
export type BookingRef =
  { readonly bookingId: string } | { readonly bookingCode: string };

/**
 * One sentence for "not there" and "not yours", so a refusal never confirms
 * that a booking exists. The handlers say the same for a missing one.
 */
export const NO_SUCH_BOOKING = 'No such booking';

/**
 * How a route asks for the STAFF rule.
 *
 *   flag     the default: follow STAFF_SCOPE_V1 (off, log or on). For the
 *            by-id routes that were open before the rule existed. Turning it
 *            on for them is the staff scope work, one step at a time.
 *   always   enforced, whatever STAFF_SCOPE_V1 says, a typo or "off"
 *            included. For routes born after the hole was found (self
 *            check-in): nothing ever reached another salon's booking through
 *            them, so there is nothing to keep working, and no reason to
 *            open the hole again on a new route.
 *
 * The customer rule ignores this: it is always on either way.
 */
export interface ScopeOptions {
  readonly staff?: 'flag' | 'always';
}

/**
 * The scope check at the edge of every route that acts on a booking it was
 * handed. Called first in the handler, before anything is read or written:
 *
 *   await this.scope.refuseOutOfScope({ bookingId: id }, actor,
 *     'POST /v1/bookings/:id/cancel');
 *
 * A CUSTOMER is checked always, exactly as customer-ownership.ts did it:
 * their own booking, or 404. Not behind the flag; it has been live since
 * 5f01d92.
 *
 * STAFF go through STAFF_SCOPE_V1:
 *   off  nothing is looked up, nothing changes.
 *   log  a booking the rule would refuse is LOGGED, with everything needed to
 *        tell a real salon from a QA token, and the request carries on.
 *   on   the same line is logged, and the answer is 404 "No such booking".
 * unless the route passes { staff: 'always' }, which is `on` whatever the
 * flag says (ScopeOptions).
 *
 * A booking that is not there is not this check's to answer: the request
 * carries on and the route's own handler says it is not there, as before.
 * That is safe only because the lookup finds the same row the handler would
 * act on, which booking-scope.repository.ts is careful about.
 */
@Injectable()
export class BookingScope {
  private static readonly log = new Logger('StaffScope');

  constructor(private readonly bookings: BookingScopeRepository) {}

  async refuseOutOfScope(
    ref: BookingRef,
    actor: Actor,
    route: string,
    options: ScopeOptions = {},
  ): Promise<void> {
    if (actor.kind === 'customer') {
      const booking = await this.find(ref);
      if (
        booking === null ||
        scopeVerdict(folded(actor), booking).kind === 'refused'
      ) {
        throw new NotFoundException(NO_SUCH_BOOKING);
      }
      return;
    }

    const always = options.staff === 'always';
    const mode = always ? 'on' : STAFF_SCOPE_V1();
    if (mode === 'off') return;

    const booking = await this.find(ref);
    if (booking === null) return;

    const verdict = scopeVerdict(folded(actor), booking);
    if (verdict.kind === 'allowed') return;

    BookingScope.log.warn(
      refusalLine(
        always ? 'always on' : `STAFF_SCOPE_V1=${mode}`,
        mode,
        verdict.why,
        route,
        actor,
        booking,
      ),
    );
    if (mode === 'on') throw new NotFoundException(NO_SUCH_BOOKING);
  }

  private find(ref: BookingRef): Promise<ScopedBookingRow | null> {
    return 'bookingCode' in ref
      ? this.bookings.byCode(ref.bookingCode)
      : this.bookings.byId(ref.bookingId);
  }
}

/** The actor as the rule compares it: ids folded to what the columns hold. */
function folded(actor: Actor): ScopeActor {
  const branch = (actor.branchId ?? '').trim();
  return {
    kind: actor.kind,
    id: toUuid(actor.id),
    tenantId: actor.tenantId,
    branchId: branch === '' ? null : toUuid(branch),
  };
}

/**
 * THE EVIDENCE FOR TURNING IT ON. One line per refusal, key=value so it
 * greps: which route, why, who (kind, id, the token's tenant and branch),
 * and which booking (id, code, its tenant and branch). A QA token shows
 * itself by its tenant (qa-..., proof-script) or the marina-walk branch; a
 * real salon by a real tenant uuid on both sides.
 *
 * The token's values are printed as the token carried them, not folded, so
 * the line can be matched against the platform.
 *
 * `source` says what made the check run: the flag's value, or "always on"
 * for a route that never follows it.
 */
function refusalLine(
  source: string,
  mode: ScopeMode,
  why: ScopeRefusal,
  route: string,
  actor: Actor,
  booking: ScopedBookingRow,
): string {
  return [
    `${mode === 'on' ? 'REFUSED' : 'WOULD REFUSE'}`,
    `(${source}) ${why}: ${route}`,
    `actor=${actor.kind}:${actor.id}`,
    `token_tenant=${actor.tenantId ?? 'none'}`,
    `token_branch=${actor.branchId ?? 'all'}`,
    `booking=${booking.id}`,
    `code=${booking.code}`,
    `booking_tenant=${booking.tenantId ?? 'none'}`,
    `booking_branch=${booking.branchId}`,
  ].join(' ');
}
