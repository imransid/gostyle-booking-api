import { Inject, Injectable, Logger } from '@nestjs/common';
import { PlatformPackageCatalogue } from '@infrastructure/persistence/platform-package-catalogue';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { expandPackage } from '@domain/booking/package';
import { filsToAed } from '@domain/booking/mobile-contract';
import { LoadedServices } from '@application/commands/basket';
import { isBookingError } from '@application/contract/errors';
import { oneCurrency } from '@domain/booking/service-resolution';

/** One package on sale at a branch, priced exactly as a booking of it is. */
export interface PackageOffer {
  readonly id: string;
  readonly name: string;
  /** What the package sells for, net of VAT. What a booking of it charges. */
  readonly priceFils: number;
  /** The parts at their own prices. Display only. */
  readonly partsTotalFils: number;
  /** Parts minus price, never below zero. Display only. */
  readonly savingFils: number;
  /** The parts end to end. A guide for the picker; the quote decides. */
  readonly durationMin: number;
  readonly parts: readonly {
    readonly id: string;
    readonly name: string;
    /** This part's share of the package price, as a booking stores it. */
    readonly priceFils: number;
    readonly durationMin: number;
  }[];
}

/**
 * The packages a branch sells, for the app's picker and the desk's.
 *
 * ONE LIST, TWO SHAPES. The mobile route answers in the app contract's
 * vocabulary (`list`), the desk route in the desk's (`offers`, mapped by its
 * controller), and both read these figures, which come from the same
 * expansion a booking of the package runs (package.ts, basket.ts). So a
 * package can never be listed at one price and sold at another.
 *
 * A BROKEN PACKAGE IS SKIPPED, NOT FATAL. One with a part the catalogue
 * cannot find must not empty the whole list; it is logged and left out. The
 * ids returned are what the app sends back as a `services[].id` line on
 * create, with `amount` = `amount_without_tax` here: the package's price.
 */
@Injectable()
export class MobilePackagesHandler {
  private static readonly log = new Logger(MobilePackagesHandler.name);

  constructor(
    private readonly packages: PlatformPackageCatalogue,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async offers(branchId: string): Promise<readonly PackageOffer[]> {
    const sold = await this.packages.forBranch(branchId);
    if (sold.length === 0) return [];

    // Every part of every package in ONE lookup, not one per package...
    const partIds = [...new Set(sold.flatMap((p) => p.serviceIds))];
    let all: LoadedServices | null = null;
    try {
      all = new LoadedServices().add(
        await this.context.loadServices(branchId, partIds),
      );
    } catch (e) {
      /**
       * ...UNLESS ONE PACKAGE SPOILS IT. The catalogue refuses a whole
       * load for one part priced at nothing, or for parts in two currencies
       * -- which two packages sold in their own currencies are, together --
       * and the list answered 422 for the branch. Then each package is
       * looked up on its own, and only the ones that cannot be sold are left
       * out. An outage is not a refusal: it is the platform's answer for the
       * whole list, and stays one.
       */
      if (!isBookingError(e) || e.code === 'DEPENDENCY_UNAVAILABLE') throw e;
      MobilePackagesHandler.log.warn(
        `packages at ${branchId}: one lookup refused (${e.message}); ` +
          'looking each package up on its own.',
      );
    }

    const out: PackageOffer[] = [];
    for (const pkg of sold) {
      let loaded = all;
      if (loaded === null) {
        try {
          loaded = new LoadedServices().add(
            await this.context.loadServices(branchId, [
              ...new Set(pkg.serviceIds),
            ]),
          );
        } catch (e) {
          if (!isBookingError(e) || e.code === 'DEPENDENCY_UNAVAILABLE') {
            throw e;
          }
          MobilePackagesHandler.log.warn(
            `package ${pkg.id} left out of the list: ${e.message}`,
          );
          continue;
        }
      }
      const found = loaded;

      const missing = pkg.serviceIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        MobilePackagesHandler.log.warn(
          `package ${pkg.id} left out of the list: parts not found: ` +
            `${[...new Set(missing)].join(', ')}`,
        );
        continue;
      }

      // The rule every sale applies (basket.ts): a package and its parts in
      // one currency. Listed otherwise, it was offered and then refused.
      const verdict = oneCurrency([
        { currency: pkg.currency },
        ...pkg.serviceIds.map((id) => found.get(id)!),
      ]);
      if (verdict.kind === 'mixed') {
        MobilePackagesHandler.log.warn(
          `package ${pkg.id} left out of the list: priced in a different ` +
            `currency from its parts (${verdict.currencies.join(' and ')}).`,
        );
        continue;
      }

      const e = expandPackage(pkg, (id) => found.listPrice(id));
      const parts = pkg.serviceIds.map((id, i) => {
        const sv = found.get(id)!;
        return {
          id: sv.id,
          name: sv.name,
          priceFils: e.partPricesFils[i] ?? 0,
          durationMin: sv.durationMin,
        };
      });
      out.push({
        id: pkg.id,
        name: pkg.name,
        priceFils: e.packagePriceFils,
        partsTotalFils: e.partsTotalFils,
        savingFils: e.savingFils,
        durationMin: parts.reduce((n, p) => n + p.durationMin, 0),
        parts,
      });
    }
    return out;
  }

  async list(salonId: string): Promise<{
    count: number;
    results: readonly Record<string, unknown>[];
  }> {
    const offers = await this.offers(salonId);
    const results = offers.map((o) => ({
      id: o.id,
      name: o.name,
      // Net of VAT, like every services[].amount the app already sees, and
      // the `amount` to send on this package's line at create.
      amount_without_tax: filsToAed(o.priceFils),
      parts_total: filsToAed(o.partsTotalFils),
      savings: filsToAed(o.savingFils),
      // Sum of the parts. The create's quote stays the authority on the
      // real visit length; treat this as a guide for the picker.
      duration_min: o.durationMin,
      services: o.parts.map((p) => ({
        id: p.id,
        name: p.name,
        amount: filsToAed(p.priceFils),
      })),
    }));
    return { count: results.length, results };
  }
}
