/**
 * One sellable VARIANT (one size / one SKU), as platform lists it.
 *
 * `variantId` is the id the app sends and the id booking_product stores.
 * `productId` is the parent product, carried for display only.
 */
export interface CatalogueProduct {
  readonly variantId: string;
  readonly productId: string;
  readonly productName: string;
  readonly variantName: string;
  readonly sku: string;
  /** Whole minor units, exactly as the wire said. Not judged here. */
  readonly priceMinor: number;
  /** '' when platform sent none. Never defaulted to AED. */
  readonly currency: string;
  readonly imageUrl: string | null;
  readonly categoryName: string | null;
  /** false = nobody counts this item at this branch: sell freely. */
  readonly tracked: boolean;
  /** On hand minus live POS holds. Can be negative. Ignore when !tracked. */
  readonly available: number;
}

export interface ProductsDirectoryReader {
  /**
   * The variants asked for, at one branch, with that branch's stock.
   *
   * `variantIds` MUST NOT BE EMPTY: platform reads an empty list as "every
   * variant". `branchId` MUST BE A REAL BRANCH UUID: without one, platform
   * reports every item as untracked, which switches the stock check off.
   *
   * A variant that is unknown, deleted, inactive or not RETAIL is simply
   * absent from the answer.
   *
   * THROWS rather than answering [] when it could not ask, same as
   * ServicesDirectoryReader.
   */
  listProducts(
    tenantId: string,
    branchId: string,
    variantIds: readonly string[],
  ): Promise<CatalogueProduct[]>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const PRODUCTS_DIRECTORY = Symbol('PRODUCTS_DIRECTORY');
