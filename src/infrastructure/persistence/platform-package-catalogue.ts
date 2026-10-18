import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SERVICES_DIRECTORY,
  type CataloguePackage,
  type ServicesDirectoryReader,
} from '@application/ports/services-directory.port';
import type { ServicePackage } from '@domain/booking/package';
import { looksLikePlatformId } from '@domain/booking/service-resolution';
import { PACKAGES } from '../fixtures/fixture-booking-context';
import { TenantContext } from '../tenancy/tenant-context';

/** Off by default. With it off, a real branch sells no packages. */
export const PACKAGES_FROM_PLATFORM = (): boolean =>
  (process.env.PACKAGES_FROM_PLATFORM ?? '').trim().toLowerCase() === 'true';

/**
 * How long one branch's package list is reused. A mobile create resolves its
 * basket four times (check, quote, hold, confirm), and each was a ListPackages
 * call. A minute is short enough that a price change reaches the next
 * booking, and long enough that one booking asks once.
 */
export const PACKAGE_LIST_TTL_MS = 60_000;

const log = new Logger('PlatformPackageCatalogue');

@Injectable()
export class PlatformPackageCatalogue {
  private readonly cache = new Map<
    string,
    { readonly at: number; readonly packages: readonly ServicePackage[] }
  >();

  constructor(
    @Inject(SERVICES_DIRECTORY)
    private readonly directory: ServicesDirectoryReader,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * The packages a branch sells.
   *
   * THE DEMO PACKAGES BELONG TO THE DEMO SALON. The three fixture packages
   * answer only for a slug branch ("marina-walk"), which is the fixture's
   * own world -- the proof scripts and the desk tests. They used to be
   * appended to every real branch's list, and with the switch off they WERE
   * every real branch's list, so the app was offered "Bridal morning" at
   * salons that never sold it.
   *
   * A real branch sells what the platform says, with the switch on, and
   * nothing with it off.
   */
  async forBranch(branchId: string): Promise<readonly ServicePackage[]> {
    if (!looksLikePlatformId(branchId)) return PACKAGES;
    if (!PACKAGES_FROM_PLATFORM()) return [];

    const tenantId = this.tenants.current();
    if (tenantId === null || !looksLikePlatformId(tenantId)) {
      // ListPackages is tenant-scoped and refuses anything but a uuid;
      // guessing a tenant would read somebody else's menu.
      log.warn(
        `Cannot list platform packages for branch ${branchId}: ` +
          `${tenantId === null ? 'no X-Tenant-Id on this request' : `tenant "${tenantId}" is not a uuid`}. ` +
          'Selling no packages.',
      );
      return [];
    }

    const key = `${tenantId}:${branchId}`.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < PACKAGE_LIST_TTL_MS) {
      return hit.packages;
    }

    // A failure is NOT cached: the next request asks again.
    const rows = await this.directory.listPackages(tenantId, branchId);
    const packages = rows
      .map((r) => usable(r))
      .filter((p): p is ServicePackage => p !== null);

    log.log(
      `packages branch=${branchId} platform=${packages.length} ` +
        `skipped=${rows.length - packages.length}`,
    );
    this.cache.set(key, { at: Date.now(), packages });
    return packages;
  }
}

/** A platform row as a package booking can sell, or null when it cannot. */
function usable(r: CataloguePackage): ServicePackage | null {
  const serviceIds = r.items.flatMap((i) =>
    Array<string>(Math.max(1, i.quantity)).fill(i.serviceId),
  );
  if (r.id === '' || serviceIds.length === 0 || r.priceMinor <= 0) {
    log.warn(`Skipping unusable package ${r.id}`);
    return null;
  }

  /**
   * A NAMED VARIANT CANNOT BE BOOKED YET. "Long hair" is a service variant
   * with its own price and minutes, and booking knows services, not their
   * variants: it would reserve the base service's time for a longer visit.
   * Left out here, so it is never sold short, and the app's tab says the
   * same through can_book (customer-api, apps/salons/packages.py).
   */
  if (r.items.some((i) => (i.variantId ?? '') !== '')) {
    log.warn(
      `Skipping package ${r.id}: it names a service variant, which booking ` +
        'cannot book yet.',
    );
    return null;
  }

  return {
    id: r.id,
    name: r.name,
    serviceIds,
    priceFils: r.priceMinor,
    ...(r.currency === '' ? {} : { currency: r.currency }),
  };
}
