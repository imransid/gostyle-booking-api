import { describe, it, expect } from 'vitest';
import {
  MAX_PRODUCT_QUANTITY,
  NO_PRODUCTS,
  addProducts,
  checkProducts,
  productMoney,
  type ProductCheck,
  type ProductLineClaim,
  type ProductOffer,
} from './mobile-products';

/**
 * DOMAIN SPEC — plain data in, a verdict out. No server, no mocks.
 *
 * Every agreed product rule is decided in checkProducts, so every one of
 * them is pinned here: what counts as sellable, which currency, what price,
 * how much stock, and what the products add to the bill.
 */

// Letters in every group, so lowercasing is visible.
const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const SPRAY = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';
const STRANGER = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';

const offer = (
  variantId: string,
  over: Partial<ProductOffer> = {},
): ProductOffer => ({
  variantId,
  productName: 'Argan Oil',
  variantName: '100 ml',
  priceMinor: 8_500,
  currency: 'AED',
  tracked: true,
  available: 10,
  ...over,
});

const offers = (...rows: ProductOffer[]): ReadonlyMap<string, ProductOffer> =>
  new Map(rows.map((r) => [r.variantId.toLowerCase(), r]));

const check = (
  lines: ProductLineClaim[],
  catalogue: ReadonlyMap<string, ProductOffer> = offers(offer(OIL)),
  currency = 'AED',
): ProductCheck => checkProducts({ lines, offers: catalogue, currency });

/** The priced result, or a failed test that says what was refused. */
function ok(result: ProductCheck) {
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result;
}

function refused(result: ProductCheck) {
  if (result.kind !== 'refused') {
    throw new Error(`expected refused, got ${JSON.stringify(result.lines)}`);
  }
  return result.errors;
}

describe('one good line', () => {
  it('is priced from the catalogue, never from the app', () => {
    const r = ok(check([{ id: OIL, amount: 85 }]));

    expect(r.lines).toStrictEqual([
      {
        productId: OIL,
        productName: 'Argan Oil (100 ml)',
        priceFils: 8_500,
        quantity: 1,
      },
    ]);
  });

  it('stores the variant id lowercased, whatever case the app sent', () => {
    const r = ok(check([{ id: OIL.toUpperCase(), amount: 85 }]));

    expect(r.lines[0]!.productId).toBe(OIL);
  });

  it('names a line with no variant name by the product alone', () => {
    const r = ok(
      check([{ id: OIL, amount: 85 }], offers(offer(OIL, { variantName: '' }))),
    );

    expect(r.lines[0]!.productName).toBe('Argan Oil');
  });

  it('does not repeat a variant name that is the product name', () => {
    const r = ok(
      check(
        [{ id: OIL, amount: 85 }],
        offers(offer(OIL, { variantName: 'Argan Oil' })),
      ),
    );

    expect(r.lines[0]!.productName).toBe('Argan Oil');
  });
});

describe('quantity', () => {
  it('means 1 when omitted', () => {
    const r = ok(check([{ id: OIL, amount: 85 }]));

    expect(r.lines[0]!.quantity).toBe(1);
    expect(r.money.netFils).toBe(8_500);
  });

  it('multiplies the net: 3 of an AED 85 item is AED 255', () => {
    const r = ok(check([{ id: OIL, amount: 85, quantity: 3 }]));

    expect(r.lines[0]!.quantity).toBe(3);
    expect(r.money.netFils).toBe(25_500);
  });

  it.each([0, 1.5, MAX_PRODUCT_QUANTITY + 1])(
    'throws for %s, which the DTO should have refused first',
    (quantity) => {
      expect(() => check([{ id: OIL, amount: 85, quantity }])).toThrow(
        /quantity must be a whole number/,
      );
    },
  );
});

describe('the products money', () => {
  it('is net + 5% VAT', () => {
    expect(productMoney([{ priceFils: 8_500, quantity: 2 }])).toStrictEqual({
      netFils: 17_000,
      vatFils: 850,
      totalFils: 17_850,
    });
  });

  it('rounds the VAT ONCE, on the products net, not once per line', () => {
    // 5% of 1010 fils is 50.5. Rounded per line that is 51 + 51 = 102;
    // rounded once on the 2020 net it is 101. The second is the rule.
    const m = productMoney([
      { priceFils: 1_010, quantity: 1 },
      { priceFils: 1_010, quantity: 1 },
    ]);

    expect(m).toStrictEqual({ netFils: 2_020, vatFils: 101, totalFils: 2_121 });
  });

  it('rounds a half fil of VAT on a single line', () => {
    expect(productMoney([{ priceFils: 1_010, quantity: 1 }]).vatFils).toBe(51);
  });

  it('is what checkProducts reports for the lines it priced', () => {
    const r = ok(
      check(
        [
          { id: OIL, amount: 85, quantity: 2 },
          { id: SPRAY, amount: 40 },
        ],
        offers(offer(OIL), offer(SPRAY, { priceMinor: 4_000 })),
      ),
    );

    expect(r.money).toStrictEqual(productMoney(r.lines));
    expect(r.money).toStrictEqual({
      netFils: 21_000,
      vatFils: 1_050,
      totalFils: 22_050,
    });
  });

  it('is exactly NO_PRODUCTS for no lines', () => {
    expect(productMoney([])).toStrictEqual(NO_PRODUCTS);
  });
});

describe('addProducts', () => {
  const services = {
    subtotalFils: 18_000,
    vatFils: 800,
    discountFils: 2_000,
    totalFils: 16_800,
  };

  it('adds net to subtotal, VAT to VAT and total to total', () => {
    expect(
      addProducts(services, {
        netFils: 4_500,
        vatFils: 225,
        totalFils: 4_725,
      }),
    ).toStrictEqual({
      subtotalFils: 22_500,
      vatFils: 1_025,
      discountFils: 2_000,
      totalFils: 21_525,
    });
  });

  it('never lets a discount reach a product', () => {
    const sum = addProducts(services, {
      netFils: 4_500,
      vatFils: 225,
      totalFils: 4_725,
    });

    expect(sum.discountFils).toBe(services.discountFils);
  });

  it('changes nothing when there are no products', () => {
    expect(addProducts(services, NO_PRODUCTS)).toStrictEqual(services);
  });

  it('still adds up: subtotal - discount + VAT = total', () => {
    const sum = addProducts(services, {
      netFils: 4_500,
      vatFils: 225,
      totalFils: 4_725,
    });

    expect(sum.subtotalFils - sum.discountFils + sum.vatFils).toBe(
      sum.totalFils,
    );
  });
});

describe('unknown_product, at products[i].id', () => {
  it.each([
    ['an id the catalogue did not return', offers(offer(SPRAY))],
    ['a price of 0', offers(offer(OIL, { priceMinor: 0 }))],
    ['a fractional price', offers(offer(OIL, { priceMinor: 8_500.5 }))],
    ["a currency of ''", offers(offer(OIL, { currency: '' }))],
  ])('%s', (_name, catalogue) => {
    const errors = refused(check([{ id: OIL, amount: 85 }], catalogue));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      field: 'products[0].id',
      code: 'unknown_product',
    });
  });
});

describe('currency', () => {
  it('BDT against AED services is currency_mismatch', () => {
    const errors = refused(
      check([{ id: OIL, amount: 85 }], offers(offer(OIL, { currency: 'BDT' }))),
    );

    expect(errors[0]).toMatchObject({
      field: 'products[0].id',
      code: 'currency_mismatch',
    });
  });

  it("'aed' against 'AED' is the same currency", () => {
    ok(
      check([{ id: OIL, amount: 85 }], offers(offer(OIL, { currency: 'aed' }))),
    );
  });

  it("services currency '' (a mixed basket) fails every product", () => {
    const errors = refused(check([{ id: OIL, amount: 85 }], undefined, ''));

    expect(errors[0]!.code).toBe('currency_mismatch');
  });
});

describe('the unit amount the app sent', () => {
  it('passes 1 fil off, and still charges the catalogue price', () => {
    const r = ok(check([{ id: OIL, amount: 85.01 }]));

    expect(r.lines[0]!.priceFils).toBe(8_500);
  });

  it('refuses 2 fils off, naming the catalogue price', () => {
    const errors = refused(check([{ id: OIL, amount: 85.02 }]));

    expect(errors).toStrictEqual([
      {
        field: 'products[0].amount',
        code: 'amount_mismatch',
        message: 'Prices changed since this booking was started.',
        expected: 85,
      },
    ]);
  });

  it('refuses an amount with three decimals', () => {
    const errors = refused(check([{ id: OIL, amount: 85.005 }]));

    expect(errors[0]).toMatchObject({
      field: 'products[0].amount',
      code: 'amount_mismatch',
      expected: 85,
    });
  });
});

describe('stock', () => {
  it('tracked, 2 available, 3 wanted is out_of_stock', () => {
    const errors = refused(
      check(
        [{ id: OIL, amount: 85, quantity: 3 }],
        offers(offer(OIL, { available: 2 })),
      ),
    );

    expect(errors).toStrictEqual([
      {
        field: 'products[0].quantity',
        code: 'out_of_stock',
        message: 'Only 2 left at this salon.',
      },
    ]);
  });

  it('tracked, exactly enough available, passes', () => {
    ok(
      check(
        [{ id: OIL, amount: 85, quantity: 2 }],
        offers(offer(OIL, { available: 2 })),
      ),
    );
  });

  it.each([0, -4])(
    'untracked with available %s is sold freely',
    (available) => {
      ok(
        check(
          [{ id: OIL, amount: 85, quantity: 5 }],
          offers(offer(OIL, { tracked: false, available })),
        ),
      );
    },
  );

  it('a negative available (an oversell) says "Only 0 left"', () => {
    const errors = refused(
      check([{ id: OIL, amount: 85 }], offers(offer(OIL, { available: -3 }))),
    );

    expect(errors[0]!.message).toBe('Only 0 left at this salon.');
  });

  it('counts the same variant across lines: 2 + 2 against 3 is out_of_stock', () => {
    // Either line alone would fit. Together they come off one shelf.
    const errors = refused(
      check(
        [
          { id: OIL, amount: 85, quantity: 2 },
          { id: OIL.toUpperCase(), amount: 85, quantity: 2 },
        ],
        offers(offer(OIL, { available: 3 })),
      ),
    );

    expect(errors.map((e) => [e.field, e.code])).toStrictEqual([
      ['products[0].quantity', 'out_of_stock'],
      ['products[1].quantity', 'out_of_stock'],
    ]);
  });
});

describe('several bad lines', () => {
  it('reports every one, in line order, and prices nothing', () => {
    const result = check(
      [
        { id: OIL, amount: 85 }, // fine
        { id: STRANGER, amount: 10 }, // unknown
        { id: SPRAY, amount: 99 }, // wrong price
        { id: 'argan-oil', amount: 85 }, // a slug: never in the map
      ],
      offers(offer(OIL), offer(SPRAY, { priceMinor: 4_000 })),
    );

    const errors = refused(result);
    expect(errors.map((e) => [e.field, e.code])).toStrictEqual([
      ['products[1].id', 'unknown_product'],
      ['products[2].amount', 'amount_mismatch'],
      ['products[3].id', 'unknown_product'],
    ]);
    expect(result).not.toHaveProperty('lines');
    expect(result).not.toHaveProperty('money');
  });
});
