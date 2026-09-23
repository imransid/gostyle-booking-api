import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import {
  MobileBookingDto,
  MobileProductLineDto,
} from './mobile-booking.controller';
import { mobileValidationPipe } from './mobile-validation.pipe';
import { isMobileContractError } from '@application/commands/mobile-booking.error';
import { MAX_PRODUCT_QUANTITY } from '@domain/booking/mobile-products';

/**
 * DTO SPEC — run through the REAL pipe, because the pipe is half the rule.
 *
 * `whitelist: true` means a property with no validation decorator is
 * SILENTLY STRIPPED before the handler ever sees it. That is the failure
 * this file exists for: `products` used to be typed `MobileLineDto`, which
 * has no `quantity`, so a basket of three bottles would have arrived as a
 * basket of one -- no error, no log, two bottles the salon never charges
 * for. Nothing else in the codebase notices a field that quietly vanishes,
 * so it is asserted here on the object the pipe actually produces.
 *
 * The other half is the range. `booking_product.quantity` is a SMALLINT and
 * `quantityOf` in the domain THROWS for anything outside 1..99 -- on purpose,
 * because by then it is our bug. The DTO is what stops it being reached, so
 * each edge of that range is pinned.
 */

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: MobileBookingDto,
  data: '',
};

const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    salon_id: 'marina-walk',
    services: [{ id: 'haircut-finish', amount: 160 }],
    stylists: ['maya'],
    date: '2026-09-20',
    start_time: '2026-09-20T14:00:00+06:00',
    end_time: '2026-09-20T14:45:00+06:00',
    amount_without_tax: 160,
    tax_amount: 8,
    discount: 0,
    total: 168,
    advance_paid_amount: 0,
    due_amount: 168,
    payment_status: 'DRAFT',
    status: 'BOOKED',
    booking_type: 'SINGLE',
    ...over,
  };
}

/** The validated DTO, or a failure naming the field errors. */
async function accepted(
  raw: Record<string, unknown>,
): Promise<MobileBookingDto> {
  try {
    return (await mobileValidationPipe().transform(
      raw,
      meta,
    )) as MobileBookingDto;
  } catch (e) {
    if (isMobileContractError(e)) {
      throw new Error(
        `expected accepted, refused with ${JSON.stringify(e.errors)}`,
      );
    }
    throw e;
  }
}

/** The field errors, or a failure saying it was accepted. */
async function refused(raw: Record<string, unknown>) {
  try {
    await mobileValidationPipe().transform(raw, meta);
  } catch (e) {
    if (isMobileContractError(e)) return e.errors;
    throw e;
  }
  throw new Error('expected a refusal, the body was accepted');
}

describe('a product line survives the pipe intact', () => {
  it('keeps `quantity`, which whitelist would strip off the plain line DTO', async () => {
    const dto = await accepted(
      body({ products: [{ id: OIL, amount: 85, quantity: 3 }] }),
    );

    expect(dto.products?.[0]?.quantity).toBe(3);
  });

  it('builds the product line class, not the plain one', async () => {
    const dto = await accepted(
      body({ products: [{ id: OIL, amount: 85, quantity: 2 }] }),
    );

    expect(dto.products?.[0]).toBeInstanceOf(MobileProductLineDto);
  });

  it('leaves `quantity` undefined when it is omitted, rather than inventing a 1', async () => {
    // The default lives in the domain (`quantityOf`), in one place. A second
    // default here would be a second thing to change (CLAUDE.md 4).
    const dto = await accepted(body({ products: [{ id: OIL, amount: 85 }] }));

    expect(dto.products?.[0]?.quantity).toBeUndefined();
  });

  it('keeps the id and the unit amount', async () => {
    const dto = await accepted(body({ products: [{ id: OIL, amount: 85.5 }] }));

    expect(dto.products?.[0]?.id).toBe(OIL);
    expect(dto.products?.[0]?.amount).toBe(85.5);
  });
});

describe('quantity is a whole number from 1 to 99', () => {
  const line = (quantity: unknown) =>
    body({ products: [{ id: OIL, amount: 85, quantity }] });

  it.each([1, 2, MAX_PRODUCT_QUANTITY])('accepts %s', async (quantity) => {
    const dto = await accepted(line(quantity));
    expect(dto.products?.[0]?.quantity).toBe(quantity);
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['over the SMALLINT guard', MAX_PRODUCT_QUANTITY + 1],
    ['a numeric string', '2'],
  ])('refuses %s', async (_name, quantity) => {
    const errors = await refused(line(quantity));
    expect(errors[0]?.field).toBe('products');
  });
});

describe('the rest of a product line is checked like a service line', () => {
  it('refuses a missing id', async () => {
    expect(
      (await refused(body({ products: [{ amount: 85 }] })))[0]?.field,
    ).toBe('products');
  });

  it('refuses a negative amount', async () => {
    expect(
      (await refused(body({ products: [{ id: OIL, amount: -5 }] })))[0]?.field,
    ).toBe('products');
  });

  it('refuses three decimal places, the same as everywhere else', async () => {
    expect(
      (await refused(body({ products: [{ id: OIL, amount: 85.005 }] })))[0]
        ?.field,
    ).toBe('products');
  });

  it('refuses a key nobody declared, rather than dropping it', async () => {
    // forbidNonWhitelisted. A `price` the app thinks it is sending, silently
    // ignored, is the same class of bug as the stripped quantity.
    const errors = await refused(
      body({ products: [{ id: OIL, amount: 85, price: 90 }] }),
    );
    expect(errors[0]?.field).toBe('products');
  });
});

describe('no products is still a perfectly good body', () => {
  it('accepts the key omitted', async () => {
    const dto = await accepted(body());
    expect(dto.products).toBeUndefined();
  });

  it('accepts an empty array', async () => {
    const dto = await accepted(body({ products: [] }));
    expect(dto.products).toStrictEqual([]);
  });

  it('refuses products that are not an array at all', async () => {
    expect((await refused(body({ products: 'oil' })))[0]?.field).toBe(
      'products',
    );
  });
});

describe('a bad product line is reported in the app’s envelope', () => {
  it('reports the root field, because that is what a form can highlight', async () => {
    // `products.0.quantity` is not something the app's form knows about.
    const errors = await refused(
      body({ products: [{ id: OIL, amount: 85, quantity: 0 }] }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('products');
  });

  it('carries the contract code the pipe maps `products` to', async () => {
    /**
     * PINNED AS BUILT. §9's code list is closed and `products` maps to
     * `unknown_product`, so a malformed QUANTITY is reported with the code
     * for an unknown product. The message beside it is class-validator's
     * own, which does say what is actually wrong.
     */
    const errors = await refused(
      body({ products: [{ id: OIL, amount: 85, quantity: 0 }] }),
    );

    expect(errors[0]?.code).toBe('unknown_product');
    expect(errors[0]?.message).toMatch(/quantity/);
  });

  it('reports one error per line-up, not one per broken line', async () => {
    const errors = await refused(
      body({
        products: [
          { id: OIL, amount: 85, quantity: 0 },
          { id: OIL, amount: -1 },
        ],
      }),
    );

    expect(errors).toHaveLength(1);
  });
});
