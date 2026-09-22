import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PRODUCTS_DIRECTORY,
  type CatalogueProduct,
  type ProductsDirectoryReader,
} from '@application/ports/products-directory.port';
import { TenantContext } from '../tenancy/tenant-context';
import { bookingError } from '@application/contract/errors';
import { looksLikePlatformId } from '@domain/booking/service-resolution';

/**
 * Products from platform, for the mobile booking only.
 *
 * OFF BY DEFAULT. `PRODUCTS_FROM_PLATFORM=true` turns it on. With the flag
 * off nothing calls this, and the mobile booking refuses products with
 * products_not_supported exactly as before.
 *
 * READS, DOES NOT JUDGE. Whether a variant is sellable, priced right, in the
 * right currency and in stock is decided in the domain, where it is tested
 * without a server. This fetches the rows, and refuses the requests whose
 * answer would be wrong without anyone noticing.
 */
export const PRODUCTS_FROM_PLATFORM = (): boolean =>
  (process.env.PRODUCTS_FROM_PLATFORM ?? '').trim().toLowerCase() === 'true';

@Injectable()
export class PlatformProductCatalogue {
  private static readonly log = new Logger(PlatformProductCatalogue.name);

  constructor(
    @Inject(PRODUCTS_DIRECTORY)
    private readonly directory: ProductsDirectoryReader,
    private readonly tenants: TenantContext,
  ) {}

  enabled(): boolean {
    return PRODUCTS_FROM_PLATFORM();
  }

  /**
   * The variants platform knows, keyed by LOWERCASE variant id.
   *
   * A missing key means unknown or not sellable; the caller says so per
   * line. Ids that are not uuids are never sent -- platform would refuse the
   * whole call with INVALID_ARGUMENT -- so they simply come back missing.
   */
  async resolve(
    branchId: string,
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, CatalogueProduct>> {
    if (!this.enabled()) {
      // A caller that forgot the flag. Loud, because the alternative is
      // selling products the operator has not switched on.
      throw new Error(
        'PlatformProductCatalogue.resolve called with PRODUCTS_FROM_PLATFORM off',
      );
    }

    const notUuid = variantIds.filter((id) => !looksLikePlatformId(id));
    const wanted = [
      ...new Set(
        variantIds.filter(looksLikePlatformId).map((id) => id.toLowerCase()),
      ),
    ];
    // NEVER SEND AN EMPTY LIST. Platform reads [] as "every variant".
    if (wanted.length === 0) return new Map();

    const tenantId = this.tenants.current();
    if (tenantId === null || !looksLikePlatformId(tenantId)) {
      // Refused, not answered empty: an empty answer would tell the customer
      // every product they picked does not exist.
      throw bookingError(
        'BOOKING_VALIDATION_FAILED',
        'Products need the tenant (X-Tenant-Id) to be priced.',
      );
    }

    if (!looksLikePlatformId(branchId)) {
      // Refused, not sent as ''. With no branch platform reports every item
      // as untracked, and the stock check would pass everything.
      throw bookingError(
        'BOOKING_VALIDATION_FAILED',
        'Products need the platform branch id of the salon to check stock.',
        { salonId: branchId },
      );
    }

    const rows = await this.directory.listProducts(tenantId, branchId, wanted);

    // ONE ROW PER VARIANT, OR WE DO NOT KNOW THE PRICE. Same guard as
    // PlatformServiceCatalogue.resolve.
    const seen = new Map<string, number>();
    for (const r of rows) {
      const key = r.variantId.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    if (duplicated.length > 0) {
      PlatformProductCatalogue.log.error(
        `ListProducts returned MULTIPLE rows for [${duplicated.join(',')}] at ` +
          `branch ${branchId}. Refusing rather than charging a guess.`,
      );
      throw bookingError(
        'BOOKING_STATE_INVALID',
        'The product catalogue returned more than one row for a product, so ' +
          'its price is ambiguous.',
        { products: duplicated },
      );
    }

    const asked = new Set(wanted);
    const found = new Map<string, CatalogueProduct>();
    for (const r of rows) {
      const key = r.variantId.toLowerCase();
      if (!asked.has(key)) continue;
      // What the wire said, for every variant we may charge for.
      PlatformProductCatalogue.log.log(
        `wire variant=${r.variantId} product="${r.productName}" ` +
          `variant="${r.variantName}" price_minor=${r.priceMinor} ` +
          `(${typeof r.priceMinor}) currency=${r.currency} ` +
          `tracked=${r.tracked} available=${r.available}`,
      );
      found.set(key, r);
    }

    PlatformProductCatalogue.log.log(
      `products branch=${branchId} sent=[${wanted.join(',')}] ` +
        `missing=[${wanted.filter((id) => !found.has(id)).join(',')}] ` +
        `notUuid=[${notUuid.join(',')}]`,
    );
    return found;
  }
}
