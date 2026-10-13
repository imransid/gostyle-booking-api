import type { ActorKind } from './lifecycle';
import { mayActOn } from './customer-ownership';

/**
 * WHO MAY TOUCH WHICH BOOKING. One rule, for every route that acts on a
 * booking it was handed by id or by code.
 *
 * THE HOLE THIS CLOSES. Those routes never asked whose salon a booking was.
 * A customer has had to own it since customer-ownership.ts; staff could act
 * on ANY booking, in any branch of any tenant, given its id, and on any
 * booking at all given its GS- code, which is one sequence shared by every
 * tenant and so can simply be counted through.
 *
 * THE RULE, by the kind of token:
 *
 *   customer          their own booking. Unchanged: customer-ownership.ts.
 *
 *   staff, manager    the booking's tenant is the token's tenant, and when
 *                     the token names a branch, the booking is in it. A
 *                     token with no branch is the whole tenant: a company
 *                     owner.
 *
 *                     A token with NO tenant is the platform's own admin in
 *                     platform mode, and may act anywhere, as every staff
 *                     token could before this.
 *
 *                     A booking with NO tenant belongs to nobody, and every
 *                     tenanted token is refused it. Letting it through would
 *                     leave every untenanted row open to every tenant, which
 *                     is the hole again. The backfill gave the real salons'
 *                     rows their tenant; what is left is the marina-walk
 *                     fixture.
 *
 *   system            in-process jobs. They never come through a route, and
 *                     the rule lets them pass.
 *
 * TENANT FIRST, THEN BRANCH. The answer names the first rule that failed, so
 * the log can tell "another salon" from "another branch of the same salon".
 *
 * Ids arrive folded by the caller, as the booking stores them: the actor's
 * id and branch to the uuid the columns hold. Compared trimmed and
 * case-insensitive here, so a spelling is never a refusal.
 */

export type ScopeRefusal =
  /** A customer, and the booking is not theirs. */
  | 'not_their_booking'
  /** A tenanted staff token, and the booking has no tenant. */
  | 'untenanted_booking'
  /** A staff token of another tenant. */
  | 'other_tenant'
  /** The right tenant, but the token is bound to another branch. */
  | 'other_branch';

export type ScopeVerdict =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly why: ScopeRefusal };

export interface ScopeActor {
  readonly kind: ActorKind;
  /** Folded as the booking's customer_id is. */
  readonly id: string;
  /** Null: a token with no tenant claim (platform mode). */
  readonly tenantId: string | null;
  /** Folded to the uuid booking.branch_id holds. Null: every branch. */
  readonly branchId: string | null;
}

export interface ScopedBooking {
  readonly customerId: string | null;
  readonly tenantId: string | null;
  readonly branchId: string;
}

const ALLOWED: ScopeVerdict = { kind: 'allowed' };

const refused = (why: ScopeRefusal): ScopeVerdict => ({
  kind: 'refused',
  why,
});

export function scopeVerdict(
  actor: ScopeActor,
  booking: ScopedBooking,
): ScopeVerdict {
  switch (actor.kind) {
    case 'customer':
      return mayActOn({
        actorKind: actor.kind,
        actorId: actor.id,
        bookingCustomerId: booking.customerId,
      })
        ? ALLOWED
        : refused('not_their_booking');

    case 'system':
      return ALLOWED;

    case 'staff':
    case 'manager':
      return staffVerdict(actor, booking);
  }
}

function staffVerdict(actor: ScopeActor, booking: ScopedBooking): ScopeVerdict {
  const tokenTenant = cleanId(actor.tenantId);
  if (tokenTenant === null) return ALLOWED;

  const bookingTenant = cleanId(booking.tenantId);
  if (bookingTenant === null) return refused('untenanted_booking');
  if (bookingTenant !== tokenTenant) return refused('other_tenant');

  const tokenBranch = cleanId(actor.branchId);
  if (tokenBranch !== null && cleanId(booking.branchId) !== tokenBranch) {
    return refused('other_branch');
  }
  return ALLOWED;
}

/**
 * STAFF_SCOPE_V1, read. Three values and nothing else.
 *
 *   off  the staff rule is not asked; staff act as they always have
 *   log  asked, and a refusal is LOGGED and let through: the evidence
 *   on   asked, and a refusal is a 404
 *
 * Anything else is `off`, a typo included. That is the state the service
 * was in before the variable existed, which is the safe thing for a typo to
 * mean: a mistyped `on` that refused the whole desk would be an outage.
 *
 * The customer rule does not read this. It has been on since
 * customer-ownership.ts and stays on.
 */
export type ScopeMode = 'off' | 'log' | 'on';

export function staffScopeMode(raw: string | undefined): ScopeMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'log' || value === 'on' ? value : 'off';
}

/**
 * An id as this rule compares it: trimmed and lowercased; blank is absent.
 *
 * Exported for the other rules that ask "is this the booking's own tenant
 * and branch" (chair-check-in.ts), so a spelling is never a refusal there
 * either, and there is one way to compare a tenant here, not two.
 */
export function cleanId(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return value === '' ? null : value;
}
