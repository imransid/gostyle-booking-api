import type { ActorKind } from '@domain/booking/lifecycle';

/**
 * Who is making this request, in the only three kinds the booking module
 * cares about.
 *
 * The platform has nineteen roles and will grow more. None of that belongs
 * here: this service needs to know whether someone may override a booking,
 * not what their job title is.
 */
export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
  /** null means all branches. A branch manager has a real id. */
  readonly branchId: string | null;
  readonly tenantId: string | null;
  /** Customer only. Phone confirmed, which some flows require. */
  readonly verified?: boolean;
}

/**
 * Platform roles that may override.
 *
 * Anything NOT listed becomes 'staff'. That default is the point: the
 * platform already has custom roles (Sub-Assistant, manager) and will get
 * more. A role created next month must inherit the LEAST power, not the
 * most, because nobody will remember to update this list.
 */
const MANAGER_ROLES: ReadonlySet<string> = new Set([
  'super_admin',
  'company_owner',
  'branch_manager',
]);

export function rolesToKind(roles: readonly string[]): ActorKind {
  return roles.some((r) => MANAGER_ROLES.has(r.toLowerCase()))
    ? 'manager'
    : 'staff';
}
