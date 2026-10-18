import type { BookingContextReader } from '@application/ports/booking-context.port';
import { skillsRequired } from '@domain/booking/service-resolution';
import { resolveBasket, type Basket, type PackageSource } from './basket';

/** One member of a party, packages expanded, as the planner takes them. */
export interface PlannedMember {
  readonly basket: Basket;
  /** Every skill the member's services need, held by ONE professional. */
  readonly skills: readonly string[];
  /** The member's services end to end, on that one professional. */
  readonly durationMin: number;
  /**
   * The station the lane holds: the LAST part's. A chain that ends at a
   * basin is holding a basin at the end, not a styling chair.
   */
  readonly resourceType: string;
}

/**
 * A party member's services, as the planner takes them.
 *
 * THE ONE COPY. Group hold, group confirm, group availability (twice) and
 * the mobile party each loaded and measured a member's services
 * themselves, and none of them knew a package: a package id was "one or
 * more services do not exist" on four of them, and silently left out of the
 * price on the fifth. Now each member's basket goes through the same step a
 * single booking's does (basket.ts), so a member may pick a package exactly
 * as a single customer can.
 *
 * Returns the member with `basket.missing` filled in rather than refusing:
 * each caller still words its own refusal.
 */
export async function planMember(
  context: BookingContextReader,
  packages: PackageSource,
  branchId: string,
  serviceIds: readonly string[],
): Promise<PlannedMember> {
  const basket = await resolveBasket(context, packages, branchId, serviceIds);
  const last = basket.services[basket.services.length - 1];
  return {
    basket,
    skills: skillsRequired(basket.services),
    durationMin: basket.services.reduce((n, s) => n + s.durationMin, 0),
    resourceType: last?.resourceType ?? '',
  };
}
