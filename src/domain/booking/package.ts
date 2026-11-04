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
 * THE PACKAGE PRICE IS CARRIED BY ITS PARTS. Each part is charged a share of
 * the package price, in proportion to what it costs on its own, and the
 * shares always add back to the package price exactly. So every reader that
 * sums a booking's lines -- the till, desk capture, the payment link, the
 * paid-in-full decision, the agenda and the revenue figures -- charges the
 * package price without knowing a package was sold.
 *
 * THIS WAS A DISCOUNT LINE, and that was the bug. The parts were stored at
 * their full price and the saving lived only in the quote, so the app agreed
 * AED 588 for a package while the till, reading the parts, billed AED 651.
 * One figure in one place cannot disagree with itself.
 *
 * What the customer saves is still worked out, for display only: the parts'
 * usual total minus the package price. It is never subtracted again.
 */

import { Money } from '../shared/money';

export interface ServicePackage {
  readonly id: string;
  readonly name: string;
  /** In the order they are performed. The chain builder takes it from here. */
  readonly serviceIds: readonly string[];
  /** What the package sells for, net of VAT. */
  readonly priceFils: number;
  /** The currency `priceFils` is in. Absent means the house currency. */
  readonly currency?: string;
}

export interface PackageExpansion {
  readonly packageId: string;
  readonly name: string;
  readonly serviceIds: readonly string[];
  /** What the same services would cost bought separately. Display only. */
  readonly partsTotalFils: number;
  /** What the package sells for, net of VAT. THIS is what is charged. */
  readonly packagePriceFils: number;
  /**
   * The package price spread over the parts, one per entry of `serviceIds`.
   * Adds back to `packagePriceFils` exactly.
   */
  readonly partPricesFils: readonly number[];
  /** Parts minus package price, never below zero. Display only. */
  readonly savingFils: number;
  readonly explanation: string;
}

/** Where a line of an expanded selection came from. */
export interface PackageOrigin {
  readonly packageId: string;
  readonly name: string;
  /**
   * WHICH SALE of the package, counting from 0 in the order chosen. The
   * same package twice is two sales, and a booking must be able to tell
   * them apart: read back by id alone, two "Hands and feet" were one at
   * double the price.
   */
  readonly seq: number;
}

/**
 * Spread a package's price over its parts.
 *
 * Largest-remainder (`Money.allocate`), weighted by each part's own price, so
 * the shares add back to the package price and the one rounding happens here.
 * Parts the catalogue has no price for are weighted equally rather than
 * charged nothing, because a share of zero would make that part free.
 *
 * A PACKAGE DEARER THAN ITS PARTS IS SOLD AT ITS PRICE. That used to throw,
 * which the HTTP layer reported as a 500, for a package the salon's own menu
 * was selling at that price. Branch price overrides make it happen without
 * anyone doing anything wrong: the package keeps the tenant's price while a
 * part is cheaper at this branch. There is no discount line left to show a
 * surcharge on, so the saving is simply zero.
 */
export function expandPackage(
  pkg: ServicePackage,
  priceOf: (serviceId: string) => number,
): PackageExpansion {
  if (pkg.serviceIds.length === 0) {
    throw new Error(`Package ${pkg.id} contains no services`);
  }

  const listPrices = pkg.serviceIds.map((id) => Money.fils(priceOf(id)));
  const parts = Money.sum(listPrices);
  const price = Money.fils(pkg.priceFils);

  const weights = parts.isZero()
    ? pkg.serviceIds.map(() => 1)
    : listPrices.map((m) => m.fils);
  const shares = price.allocate(weights);

  const saving = price.greaterThan(parts) ? Money.ZERO : parts.minus(price);
  const count = pkg.serviceIds.length;

  return {
    packageId: pkg.id,
    name: pkg.name,
    serviceIds: [...pkg.serviceIds],
    partsTotalFils: parts.fils,
    packagePriceFils: price.fils,
    partPricesFils: shares.map((m) => m.fils),
    savingFils: saving.fils,
    explanation: !saving.isZero()
      ? `${pkg.name}: ${count} services, ${saving.toString()} less than booking them separately.`
      : price.equals(parts)
        ? `${pkg.name}: ${count} services at the usual price.`
        : `${pkg.name}: ${count} services for ${price.toString()}.`,
  };
}

/**
 * Is this id a package rather than a service?
 *
 * Case-insensitive, as service ids are: a uuid typed in capitals is the same
 * package, and missing it would send the id on as an unknown service.
 */
export function findPackage(
  packages: readonly ServicePackage[],
  id: string,
): ServicePackage | undefined {
  const wanted = id.toLowerCase();
  return packages.find((p) => p.id.toLowerCase() === wanted);
}

export interface ResolvedSelection {
  /** Every package expanded, in the order chosen. */
  readonly serviceIds: readonly string[];
  /** What each entry of `serviceIds` is charged, net of VAT. Same order. */
  readonly pricesFils: readonly number[];
  /** The package each entry came from, or null for a hand-picked service. */
  readonly origins: readonly (PackageOrigin | null)[];
  readonly expansions: readonly PackageExpansion[];
  /** What the packages save against their parts. Display only. */
  readonly savingFils: number;
}

/**
 * Turn a mixed list of service and package ids into plain service ids, each
 * with the price it is charged.
 *
 * THE ONE PLACE A PACKAGE STOPS EXISTING. Everything after this call sees a
 * list of priced services, which is the whole point: no downstream branch on
 * "is this a package", and therefore no downstream bug that only packages
 * hit.
 */
export function resolveSelection(
  ids: readonly string[],
  packages: readonly ServicePackage[],
  priceOf: (serviceId: string) => number,
): ResolvedSelection {
  const serviceIds: string[] = [];
  const pricesFils: number[] = [];
  const origins: (PackageOrigin | null)[] = [];
  const expansions: PackageExpansion[] = [];

  for (const id of ids) {
    const pkg = findPackage(packages, id);
    if (pkg === undefined) {
      serviceIds.push(id);
      pricesFils.push(Money.fils(priceOf(id)).fils);
      origins.push(null);
      continue;
    }
    const expansion = expandPackage(pkg, priceOf);
    const origin = {
      packageId: pkg.id,
      name: pkg.name,
      seq: expansions.length,
    };
    expansions.push(expansion);
    serviceIds.push(...expansion.serviceIds);
    pricesFils.push(...expansion.partPricesFils);
    origins.push(...expansion.serviceIds.map(() => origin));
  }

  const saving = Money.sum(expansions.map((e) => Money.fils(e.savingFils)));

  return {
    serviceIds,
    pricesFils,
    origins,
    expansions,
    savingFils: saving.fils,
  };
}

/** A package as a booking holds it: read back from the lines it was sold in. */
export interface SoldPackage {
  readonly packageId: string;
  readonly name: string;
  /** Its parts' prices added up: what the package was sold for, net of VAT. */
  readonly priceFils: number;
  /** The parts, in the order they are performed. */
  readonly serviceIds: readonly string[];
}

/**
 * Which packages a booking holds, from its lines.
 *
 * DERIVED, NEVER STORED TWICE. Each line records the package it was sold in
 * and carries its share of the package price, so the package's price is the
 * sum of its lines and cannot disagree with what was charged. In the order
 * the packages first appear; a hand-picked line belongs to none.
 */
export function packagesSold(
  items: readonly {
    readonly serviceId: string;
    readonly priceFils: number;
    /** Absent or null: a hand-picked line, or one written before the column. */
    readonly packageId?: string | null;
    readonly packageName?: string | null;
    /** Which sale of the package this line belongs to. */
    readonly packageSeq?: number | null;
  }[],
): readonly SoldPackage[] {
  const bySale = new Map<
    string,
    { packageId: string; name: string; fils: Money[]; serviceIds: string[] }
  >();
  for (const i of items) {
    if (i.packageId === null || i.packageId === undefined) continue;
    const packageId = i.packageId.toLowerCase();
    // One entry per SALE: the same package twice is two packages, each at
    // its own price, never one at double.
    const key = `${packageId}#${i.packageSeq ?? ''}`;
    const seen = bySale.get(key) ?? {
      packageId,
      name: i.packageName ?? '',
      fils: [],
      serviceIds: [],
    };
    seen.fils.push(Money.fils(i.priceFils));
    seen.serviceIds.push(i.serviceId);
    bySale.set(key, seen);
  }
  return [...bySale.values()].map((p) => ({
    packageId: p.packageId,
    name: p.name,
    priceFils: Money.sum(p.fils).fils,
    serviceIds: p.serviceIds,
  }));
}

/** A line of a booking as it was asked for: a service, or a whole package. */
export type AskedLine =
  | { readonly kind: 'service'; readonly id: string }
  | { readonly kind: 'package'; readonly id: string };

/**
 * A booking's lines as they were ASKED FOR, from what was stored: each
 * package sold once, in place of its parts, and every hand-picked service
 * as itself. The inverse of resolveSelection over a booking's items.
 *
 * WHY A READ NEEDS IT. The app's read and payment re-quote a booking to
 * know its deposit, and re-quoted from the stored parts a package was its
 * parts at their own prices: the deposit came out on AED 459 for a package
 * sold at AED 370, and the payment create had asked for was refused as too
 * low. Re-quoted from what was asked for, the ladder runs on the package
 * price, exactly as it did at create.
 */
export function askedFor(
  items: readonly {
    readonly serviceId: string;
    readonly packageId?: string | null;
    readonly packageSeq?: number | null;
  }[],
): readonly AskedLine[] {
  const out: AskedLine[] = [];
  let last: string | null = null;
  for (const i of items) {
    if (i.packageId === null || i.packageId === undefined) {
      out.push({ kind: 'service', id: i.serviceId });
      last = null;
      continue;
    }
    const sale = `${i.packageId.toLowerCase()}#${i.packageSeq ?? ''}`;
    if (sale !== last) out.push({ kind: 'package', id: i.packageId });
    last = sale;
  }
  return out;
}

/**
 * A line's charge spread back over the parts that make it up.
 *
 * For a party, the child rule halves each LINE -- a package is one line, at
 * its price -- and rounds once, as the app does. The parts then carry that
 * charge between them in proportion to what they carry at full price, by
 * the same largest-remainder split, so they add back to the line exactly.
 * Rounding each part instead could miss the line by a fil per part.
 */
export function spreadOverParts(
  chargedFils: number,
  partFils: readonly number[],
): number[] {
  if (partFils.length === 0) throw new Error('a line needs a part');
  const weights = partFils.every((f) => f === 0)
    ? partFils.map(() => 1)
    : partFils;
  return Money.fils(chargedFils)
    .allocate(weights)
    .map((m) => m.fils);
}
