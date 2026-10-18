import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SERVICES_DIRECTORY,
  type ServicesDirectoryReader,
} from '@application/ports/services-directory.port';
import type { ServicePackage } from '@domain/booking/package';
import { PACKAGES } from '../fixtures/fixture-booking-context';
import { TenantContext } from '../tenancy/tenant-context';

/** Off by default. With it off, the 3 fixture packages answer, as before. */
export const PACKAGES_FROM_PLATFORM = (): boolean =>
  (process.env.PACKAGES_FROM_PLATFORM ?? '').trim().toLowerCase() === 'true';

@Injectable()
export class PlatformPackageCatalogue {
  private static readonly log = new Logger(PlatformPackageCatalogue.name);

  constructor(
    @Inject(SERVICES_DIRECTORY)
    private readonly directory: ServicesDirectoryReader,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * The packages a branch sells. Real ones from platform when the switch
   * is on, plus the fixture ones so old slug-based callers keep working.
   */
  async forBranch(branchId: string): Promise<readonly ServicePackage[]> {
    if (!PACKAGES_FROM_PLATFORM()) return PACKAGES;

    const tenantId = this.tenants.current();
    if (tenantId === null) {
      PlatformPackageCatalogue.log.warn(
        'Cannot list platform packages: no X-Tenant-Id on this request. ' +
          'Using the fixture packages only.',
      );
      return PACKAGES;
    }

    const rows = await this.directory.listPackages(tenantId, branchId);
    const real: ServicePackage[] = [];
    for (const r of rows) {
      const serviceIds = r.items.flatMap((i) =>
        Array<string>(Math.max(1, i.quantity)).fill(i.serviceId),
      );
      if (r.id === '' || serviceIds.length === 0 || r.priceMinor <= 0) {
        PlatformPackageCatalogue.log.warn(`Skipping unusable package ${r.id}`);
        continue;
      }
      real.push({
        id: r.id,
        name: r.name,
        serviceIds,
        priceFils: r.priceMinor,
      });
    }

    PlatformPackageCatalogue.log.log(
      `packages branch=${branchId} platform=${real.length}`,
    );
    return [...real, ...PACKAGES];
  }
}
