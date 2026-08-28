/**
 * Packages.
 *
 * A package is a PRICING AND MERCHANDISING CONSTRUCT, never a special case in
 * the engine. It expands into the individually bookable services the branch
 * already sells, and from that moment nothing downstream knows a package was
 * involved: the chain, the skills, the buffers, the chair demand and the
 * processing bands all behave exactly as they would for a hand-picked
 * selection.
 *
 * What survives the expansion is one line in the quote. The parts are worth
 * more separately than the package costs, and the difference is the bundle
 * discount the customer is being given.
 */

import { Money } from '../shared/money';

export interface ServicePackage {
  readonly id: string;
  readonly name: string;
  /** In the order they are performed. The chain builder takes it from here. */
  readonly serviceIds: readonly string[];
  /** What the package sells for, net of VAT. */
  readonly priceFils: number;
}

export interface PackageExpansion {
  readonly packageId: string;
  readonly name: string;
  readonly serviceIds: readonly string[];
  /** What the same services would cost bought separately. */
  readonly partsTotalFils: number;
  readonly packagePriceFils: number;
  /** Parts minus package price. Never negative. */
  readonly bundleDiscountFils: number;
  readonly explanation: string;
}

/**
 * The package as a list of services and one discount line.
 *
 * Prices come from the SAME source a hand-picked selection uses, passed in
 * rather than looked up here, so a package can never quote a price the
 * catalogue has since moved away from.
 */
export function expandPackage(
  pkg: ServicePackage,
  priceOf: (serviceId: string) => number,
): PackageExpansion {
  if (pkg.serviceIds.length === 0) {
    throw new Error(`Package ${pkg.id} contains no services`);
  }

  const parts = Money.sum(pkg.serviceIds.map((id) => Money.fils(priceOf(id))));
  const price = Money.fils(pkg.priceFils);

  // A package that costs MORE than its parts is a pricing mistake, not a
  // negative discount. Clamping at zero would hide it; the quote would show
  // a surcharge dressed as a bundle and nobody would notice until a customer
  // did the arithmetic at the desk.
  if (price.greaterThan(parts)) {
    throw new Error(
      `Package ${pkg.id} costs ${price.toString()} but its parts total ` +
        `${parts.toString()}. A package cannot cost more than its parts.`,
    );
  }

  const discount = parts.minus(price);

  return {
    packageId: pkg.id,
    name: pkg.name,
    serviceIds: [...pkg.serviceIds],
    partsTotalFils: parts.fils,
    packagePriceFils: price.fils,
    bundleDiscountFils: discount.fils,
    explanation: discount.isZero()
      ? `${pkg.name}: ${pkg.serviceIds.length} services at the usual price.`
      : `${pkg.name}: ${pkg.serviceIds.length} services, ${discount.toString()} less than booking them separately.`,
  };
}

/** Is this id a package rather than a service? */
export function findPackage(
  packages: readonly ServicePackage[],
  id: string,
): ServicePackage | undefined {
  return packages.find((p) => p.id === id);
}

/**
 * Turn a mixed list of service and package ids into plain service ids.
 *
 * THE ONE PLACE A PACKAGE STOPS EXISTING. Everything after this call sees a
 * list of services, which is the whole point: no downstream branch on "is
 * this a package", and therefore no downstream bug that only packages hit.
 */
export function resolveSelection(
  ids: readonly string[],
  packages: readonly ServicePackage[],
  priceOf: (serviceId: string) => number,
): {
  readonly serviceIds: readonly string[];
  readonly expansions: readonly PackageExpansion[];
  readonly bundleDiscountFils: number;
} {
  const serviceIds: string[] = [];
  const expansions: PackageExpansion[] = [];

  for (const id of ids) {
    const pkg = findPackage(packages, id);
    if (pkg === undefined) {
      serviceIds.push(id);
      continue;
    }
    const expansion = expandPackage(pkg, priceOf);
    expansions.push(expansion);
    serviceIds.push(...expansion.serviceIds);
  }

  const discount = Money.sum(
    expansions.map((e) => Money.fils(e.bundleDiscountFils)),
  );

  return {
    serviceIds,
    expansions,
    bundleDiscountFils: discount.fils,
  };
}
