import type { BookingContextReader } from '@application/ports/booking-context.port';
import type { Service } from '@domain/availability/feasible';
import {
  findPackage,
  resolveSelection,
  type PackageExpansion,
  type PackageOrigin,
  type ServicePackage,
} from '@domain/booking/package';
import {
  oneCurrency,
  priceOfService,
} from '@domain/booking/service-resolution';
import { bookingError } from '@application/contract/errors';
import { Money } from '@domain/shared/money';
import { SERVICE_SLUGS } from '@infrastructure/fixtures/fixture-booking-context';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';

/**
 * Both spellings of a fixture service, to one key (CLAUDE.md 8).
 *
 * The series and read paths re-price a booking from its stored items, whose
 * ids are the slugs folded through toUuid, and the fixture answers such an
 * id with the SLUG. Keyed on the id as asked, that service would look
 * missing. A platform uuid is not in the index and passes through unchanged.
 */
const SPELLINGS = new SlugIndex(SERVICE_SLUGS);
const keyOf = (id: string): string => SPELLINGS.toSlug(id).toLowerCase();

/**
 * The catalogue, until a catalogue service answers over gRPC.
 *
 * Exported rather than copied. A second table would have been two
 * sources of truth for what things cost, and the group path would have
 * priced parties on different numbers than the single path used for the
 * bookings inside them: correct-looking in every test that checked shape.
 *
 * Lives here, beside the one function that turns a basket into priced
 * services, and is re-exported from confirm-booking.handler.ts so the paths
 * that already import it from there keep doing so.
 */
export const PRICE_FILS: Record<string, number> = {
  'haircut-finish': 16000,
  'blow-dry': 14000,
  'fringe-trim': 6000,
  'hair-colour': 48000,
  'full-colour': 48000,
  balayage: 72000,
  keratin: 85000,
  'gel-manicure': 18000,
  'mani-pedi': 22000,
  'luxury-facial': 38000,
  'brow-lamination': 22000,
  'hot-stone': 34000,
  'hair-wash': 4000,
};

export function priceOf(serviceId: string): number {
  return PRICE_FILS[serviceId] ?? 0;
}

/**
 * Services as loaded, answering to either spelling of an id, each with its
 * own price.
 *
 * Shared by the basket and the package list, so a package's parts are
 * priced by one rule wherever a package is shown or sold.
 */
export class LoadedServices {
  private readonly byKey = new Map<string, Service>();

  add(found: readonly Service[]): this {
    for (const s of found) this.byKey.set(keyOf(s.id), s);
    return this;
  }

  get(id: string): Service | undefined {
    return this.byKey.get(keyOf(id));
  }

  has(id: string): boolean {
    return this.byKey.has(keyOf(id));
  }

  /** What the service costs on its own, net of VAT. 0 for one not loaded. */
  listPrice(id: string): number {
    const s = this.get(id);
    return s === undefined ? 0 : priceOfService(s, priceOf);
  }
}

/** Where packages come from. PlatformPackageCatalogue, in the app. */
export interface PackageSource {
  forBranch(branchId: string): Promise<readonly ServicePackage[]>;
}

export interface Basket {
  /** The selection with every package expanded, in the order chosen. */
  readonly serviceIds: readonly string[];
  /**
   * The services, in `serviceIds` order. Shorter than `serviceIds` only when
   * something is `missing`, and every caller refuses the basket then.
   */
  readonly services: readonly Service[];
  /** What each of `services` is charged, net of VAT. Same order. */
  readonly pricesFils: readonly number[];
  /** The package each of `services` came from, or null. Same order. */
  readonly origins: readonly (PackageOrigin | null)[];
  readonly packages: readonly PackageExpansion[];
  /** Ids that are not a service here, nor a package here, nor its part. */
  readonly missing: readonly string[];
  /** The sum of `pricesFils`: the basket's net figure before any discount. */
  readonly totalFils: number;
}

/**
 * A basket of service and package ids, as priced services.
 *
 * THE ONE COPY. This was four calls pasted into six handlers -- quote,
 * availability, hold, confirm, walk-in and mobile create -- and three of the
 * branch's commits were fixes for a handler that had fallen behind the
 * others. Each handler still words its own refusal from `missing`; nothing
 * else about a basket is theirs to decide.
 *
 * PACKAGES ARE ASKED FOR ONLY WHEN THE BASKET NEEDS THEM. The package list
 * comes from the platform, and asking for it on every request put every
 * booking -- a plain haircut included -- behind ListPackages: with it down,
 * nobody could book anything. Now an id that is already a service never
 * reaches it, and an outage stops only the baskets that hold a package.
 */
export async function resolveBasket(
  context: BookingContextReader,
  packageSource: PackageSource,
  branchId: string,
  ids: readonly string[],
): Promise<Basket> {
  const loaded = new LoadedServices().add(
    await context.loadServices(branchId, ids),
  );
  const unknown = ids.filter((id) => !loaded.has(id));

  let packages: readonly ServicePackage[] = [];
  if (unknown.length > 0) {
    const sold = await packageSource.forBranch(branchId);
    packages = unknown
      .map((id) => findPackage(sold, id))
      .filter((p): p is ServicePackage => p !== undefined);

    const parts = [...new Set(packages.flatMap((p) => p.serviceIds))].filter(
      (id) => !loaded.has(id),
    );
    if (parts.length > 0) {
      loaded.add(await context.loadServices(branchId, parts));
    }

    // A package's price and its parts' prices are added and split as one
    // figure, so they must be in one currency -- the same rule, and the
    // same refusal, as a hand-picked basket that mixes two.
    for (const pkg of packages) {
      const verdict = oneCurrency([
        { currency: pkg.currency },
        ...pkg.serviceIds
          .map((id) => loaded.get(id))
          .filter((s): s is Service => s !== undefined),
      ]);
      if (verdict.kind === 'mixed') {
        throw bookingError(
          'BOOKING_CURRENCY_MIXED',
          `${pkg.name} is priced in a different currency from its services ` +
            `(${verdict.currencies.join(' and ')}). Prices in different ` +
            'currencies cannot be added, and there is no rate to convert them with.',
          { package: pkg.id, currencies: verdict.currencies },
        );
      }
    }
  }

  const selection = resolveSelection(ids, packages, (id) =>
    loaded.listPrice(id),
  );

  const services: Service[] = [];
  const pricesFils: number[] = [];
  const origins: (PackageOrigin | null)[] = [];
  const missing: string[] = [];
  selection.serviceIds.forEach((id, i) => {
    const s = loaded.get(id);
    if (s === undefined) {
      missing.push(id);
      return;
    }
    services.push(s);
    pricesFils.push(selection.pricesFils[i] ?? 0);
    origins.push(selection.origins[i] ?? null);
  });

  return {
    serviceIds: selection.serviceIds,
    services,
    pricesFils,
    origins,
    packages: selection.expansions,
    missing,
    totalFils: Money.sum(pricesFils.map((f) => Money.fils(f))).fils,
  };
}
