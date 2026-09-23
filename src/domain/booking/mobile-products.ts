/**
 * Products sold with a mobile booking: checked, priced and totalled.
 *
 * PURE: the catalogue rows arrive as plain data. Nothing here knows about
 * gRPC, Nest or Prisma (CLAUDE.md 1).
 *
 * The agreed rules, all in one place:
 *   unknown, or not sellable              -> unknown_product
 *   unit price differs from the catalogue -> amount_mismatch
 *   currency differs from the services    -> currency_mismatch
 *   tracked, and not enough available     -> out_of_stock
 *   no tier or bundle discount, 5% VAT, the deposit is not touched.
 */
import { Money } from '../shared/money';
import { VAT_PERCENT } from './quote';
import { aedToFils, amountsAgree, filsToAed } from './mobile-contract';
import { looksLikePlatformId } from './service-resolution';

/** booking_product.quantity is a SMALLINT. This keeps us far below it. */
export const MAX_PRODUCT_QUANTITY = 99;

/** One product line, as the app sent it. */
export interface ProductLineClaim {
  readonly id: string;
  /** The UNIT price the app showed, decimal AED. Checked, never stored. */
  readonly amount: number;
  /** Omitted means 1. */
  readonly quantity?: number;
}

/**
 * One variant, as the catalogue lists it.
 *
 * Declared here rather than imported, because the domain may not import
 * from the application layer. The port's CatalogueProduct fits this shape.
 */
export interface ProductOffer {
  readonly variantId: string;
  readonly productName: string;
  readonly variantName: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly tracked: boolean;
  readonly available: number;
}

/** One line, ready for booking_product. */
export interface PricedProduct {
  /** The variant id, lowercase, exactly as platform knows it. */
  readonly productId: string;
  readonly productName: string;
  /** Unit price in fils, from the catalogue. Never the app's figure. */
  readonly priceFils: number;
  readonly quantity: number;
}

/** The products' part of the bill. */
export interface ProductMoney {
  readonly netFils: number;
  readonly vatFils: number;
  readonly totalFils: number;
}

export const NO_PRODUCTS: ProductMoney = {
  netFils: 0,
  vatFils: 0,
  totalFils: 0,
};

export type ProductRefusalCode =
  'unknown_product' | 'amount_mismatch' | 'currency_mismatch' | 'out_of_stock';

export interface ProductRefusal {
  /** Names the line: `products[1].amount`. */
  readonly field: string;
  readonly code: ProductRefusalCode;
  readonly message: string;
  /** The catalogue's unit price, decimal AED. Only on amount_mismatch. */
  readonly expected?: number;
}

export type ProductCheck =
  | {
      readonly kind: 'ok';
      readonly lines: readonly PricedProduct[];
      readonly money: ProductMoney;
    }
  | { readonly kind: 'refused'; readonly errors: readonly ProductRefusal[] };

/**
 * Check every line against the catalogue, and price them if all pass.
 *
 * EVERY BAD LINE IS REPORTED, not only the first, so the app can mark them
 * all at once.
 *
 * `offers` is keyed by LOWERCASE variant id, as
 * PlatformProductCatalogue.resolve returns it. `currency` is the services'.
 */
export function checkProducts(input: {
  readonly lines: readonly ProductLineClaim[];
  readonly offers: ReadonlyMap<string, ProductOffer>;
  readonly currency: string;
}): ProductCheck {
  // STOCK IS PER VARIANT, NOT PER LINE: two lines of one item share a shelf.
  const wanted = new Map<string, number>();
  for (const line of input.lines) {
    const key = line.id.toLowerCase();
    wanted.set(key, (wanted.get(key) ?? 0) + quantityOf(line));
  }

  const errors: ProductRefusal[] = [];
  const lines: PricedProduct[] = [];

  input.lines.forEach((line, i) => {
    const at = `products[${i}]`;
    const key = line.id.toLowerCase();
    const offer = input.offers.get(key);

    if (offer === undefined || !sellable(offer)) {
      errors.push({
        field: `${at}.id`,
        code: 'unknown_product',
        message: unknownProductMessage(line.id, offer),
      });
      return;
    }

    if (!sameCurrency(offer.currency, input.currency)) {
      errors.push({
        field: `${at}.id`,
        code: 'currency_mismatch',
        message:
          `${line.id} is priced in ${offer.currency}, ` +
          "which is not this booking's currency.",
      });
      return;
    }

    const claimed = aedToFils(line.amount);
    if (claimed === null || !amountsAgree(offer.priceMinor, claimed)) {
      errors.push({
        field: `${at}.amount`,
        code: 'amount_mismatch',
        message: 'Prices changed since this booking was started.',
        expected: filsToAed(offer.priceMinor),
      });
      return;
    }

    if (offer.tracked && offer.available < (wanted.get(key) ?? 0)) {
      errors.push({
        field: `${at}.quantity`,
        code: 'out_of_stock',
        message: `Only ${Math.max(0, offer.available)} left at this salon.`,
      });
      return;
    }

    lines.push({
      productId: key,
      productName: nameOf(offer),
      priceFils: offer.priceMinor,
      quantity: quantityOf(line),
    });
  });

  if (errors.length > 0) return { kind: 'refused', errors };
  return { kind: 'ok', lines, money: productMoney(lines) };
}

/**
 * The products' money, from lines that are already priced.
 *
 * VAT is 5% of the products' net, rounded ONCE. Part C reads booking_product
 * back and calls this same function, so create and read cannot disagree.
 */
export function productMoney(
  lines: readonly { readonly priceFils: number; readonly quantity: number }[],
): ProductMoney {
  const net = Money.sum(lines.map((l) => Money.fils(l.priceFils * l.quantity)));
  const vat = net.percent(VAT_PERCENT);
  return {
    netFils: net.fils,
    vatFils: vat.fils,
    totalFils: net.plus(vat).fils,
  };
}

/** One booking_product row, as stored. */
export interface SoldProduct {
  readonly productId: string;
  readonly productName: string;
  /** Unit price, whole fils, frozen at sale. */
  readonly priceFils: number;
  readonly quantity: number;
}

/** A product line in §8's shape. `amount` is the UNIT price, as on create. */
export interface ProductOut {
  readonly id: string;
  readonly name: string;
  readonly amount: number;
  readonly quantity: number;
}

/**
 * The sold lines, as §8 returns them. From the rows, never the catalogue:
 * the catalogue moves, the sold line does not.
 */
export function productsOut(rows: readonly SoldProduct[]): ProductOut[] {
  return rows.map((r) => ({
    id: r.productId,
    name: r.productName,
    amount: filsToAed(r.priceFils),
    quantity: r.quantity,
  }));
}

/** The four figures §3 compares against the app's. */
export interface MoneyFigures {
  readonly subtotalFils: number;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number;
}

/** The services' figures plus the products'. No discount reaches a product. */
export function addProducts(
  services: MoneyFigures,
  products: ProductMoney,
): MoneyFigures {
  return {
    subtotalFils: services.subtotalFils + products.netFils,
    vatFils: services.vatFils + products.vatFils,
    discountFils: services.discountFils,
    totalFils: services.totalFils + products.totalFils,
  };
}

/**
 * Zero or a fraction is not a price, and no currency is not a currency.
 * proto3 sends 0 for a missing price, so a free item and an unpriced one
 * look the same; both are refused, as services are.
 */
function sellable(o: ProductOffer): boolean {
  return (
    Number.isInteger(o.priceMinor) &&
    o.priceMinor > 0 &&
    o.currency.trim() !== ''
  );
}

/**
 * Why a line is unknown_product, in words that point at the fix.
 *
 * ONE CODE, THREE CAUSES. The code stays unknown_product for all of them,
 * because §9's code list is closed. The message used to be "Not sold at this
 * salon" for every one, which sent people looking at the salon's shop when
 * the real mistake was almost always the id: the app sent the product's `id`
 * instead of its `variant_id`, and that id is never in the catalogue.
 *
 * Platform leaves unknown, deleted, inactive and non-RETAIL variants out of
 * its answer alike, so an id it did not return cannot be told apart any
 * further than this.
 */
function unknownProductMessage(id: string, offer?: ProductOffer): string {
  if (offer !== undefined) {
    return `${nameOf(offer)} has no price at this salon yet, so it cannot be booked.`;
  }
  if (!looksLikePlatformId(id)) {
    return `'${id}' is not a valid product id. Send the product's variant_id.`;
  }
  return (
    `No product at this salon has the variant id ${id}. ` +
    "Send the product's variant_id, not its id."
  );
}

function sameCurrency(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function quantityOf(line: ProductLineClaim): number {
  const q = line.quantity ?? 1;
  if (!Number.isInteger(q) || q < 1 || q > MAX_PRODUCT_QUANTITY) {
    // The DTO answers these with a 422 first. Reaching here is our bug.
    throw new Error(
      `quantity must be a whole number from 1 to ${MAX_PRODUCT_QUANTITY}, ` +
        `got ${q}`,
    );
  }
  return q;
}

/** "Argan Oil (100 ml)". The variant is what was sold, so it is kept. */
function nameOf(o: ProductOffer): string {
  const product = o.productName.trim();
  const variant = o.variantName.trim();
  return variant === '' || variant === product
    ? product
    : `${product} (${variant})`;
}

/** A booking's figures when they may be unknown. */
export interface MaybeFigures {
  readonly subtotalFils: number | null;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number | null;
}

/**
 * addProducts, for figures that may be missing.
 *
 * An unknown services total stays unknown: adding products to nothing
 * would report a total that leaves the services out.
 */
export function addProductsIfPriced(
  services: MaybeFigures,
  products: ProductMoney,
): MaybeFigures {
  if (services.subtotalFils === null || services.totalFils === null) {
    return services;
  }
  return addProducts(
    {
      subtotalFils: services.subtotalFils,
      vatFils: services.vatFils,
      discountFils: services.discountFils,
      totalFils: services.totalFils,
    },
    products,
  );
}
