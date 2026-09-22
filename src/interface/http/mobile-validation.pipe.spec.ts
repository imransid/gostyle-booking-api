import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { mobileValidationPipe } from './mobile-validation.pipe';
import { MobileBookingDto } from './mobile-booking.controller';
import { isMobileContractError } from '@application/commands/mobile-booking.error';

/**
 * PIPE SPEC — the ENVELOPE, not the rules.
 *
 * The rules are class-validator's and the DTO's; what this pipe decides is
 * which SHAPE a field failure comes back in. That matters because the app
 * parses one shape: `{detail, code: "validation_error", errors: [{field,
 * code, message}]}`. Without this pipe the global one throws Nest's 400 with
 * an array of prose, so the app would need two parsers depending on WHICH
 * validation failed -- and nobody finds that until a customer hits the rarer
 * branch.
 *
 * Driven through MobileBookingDto rather than a toy class, so the mapping is
 * exercised against the fields the contract actually names.
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

async function refused(raw: Record<string, unknown>) {
  try {
    await mobileValidationPipe().transform(raw, meta);
  } catch (e) {
    if (isMobileContractError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal, the body was accepted');
}

describe('every failure comes back in the contract’s envelope', () => {
  it('throws a MobileContractError, never Nest’s own 400', async () => {
    const e = await refused(body({ date: 'the twentieth' }));

    expect(e.status).toBe(422);
    expect(e.toBody()).toMatchObject({
      detail: 'Please correct the highlighted fields.',
      code: 'validation_error',
    });
  });

  it('carries a field, a code and a message on every error', async () => {
    const e = await refused(body({ date: 'the twentieth' }));

    for (const error of e.errors) {
      expect(error.field).toBeTypeOf('string');
      expect(error.code).toBeTypeOf('string');
      expect(error.message).toBeTypeOf('string');
    }
  });
});

describe('the fields §9 names get their own code', () => {
  it.each([
    ['date', 'not-a-date', 'date_mismatch'],
    ['start_time', 'noon', 'invalid_window'],
    ['end_time', 'noon', 'invalid_window'],
    ['salon_id', 42, 'not_found'],
    ['amount_without_tax', 'free', 'amount_mismatch'],
    ['tax_amount', 'free', 'amount_mismatch'],
    ['discount', 'free', 'amount_mismatch'],
    ['total', 'free', 'amount_mismatch'],
    ['advance_paid_amount', 'free', 'amount_mismatch'],
    ['due_amount', 'free', 'amount_mismatch'],
    ['services', [], 'no_services'],
    ['stylists', 'maya', 'invalid_stylists'],
    ['products', [{ id: OIL, amount: 85, quantity: 0 }], 'unknown_product'],
  ])('%s maps to %s', async (field, value, code) => {
    const e = await refused(body({ [field]: value }));

    expect(e.errors.find((x) => x.field === field)?.code).toBe(code);
  });

  it('maps `products` to unknown_product, which it did not before', async () => {
    // The row this feature added to CODE_BY_FIELD. Without it a bad basket
    // fell through to `invalid_window`, which is a code about the TIME.
    const e = await refused(body({ products: 'oil' }));

    expect(e.errors[0]).toMatchObject({
      field: 'products',
      code: 'unknown_product',
    });
  });
});

describe('a field the contract does not name', () => {
  it('falls back to a plain field error rather than inventing a code', async () => {
    // booking_type is not in CODE_BY_FIELD. The app must still receive a
    // code it has heard of, not one it will fall through a switch on.
    const e = await refused(body({ booking_type: 'WEEKLY' }));

    expect(e.errors[0]).toMatchObject({
      field: 'booking_type',
      code: 'invalid_window',
    });
  });
});

describe('nested failures are flattened to the root field', () => {
  it('reports `services`, not `services.0.amount`', async () => {
    const e = await refused(
      body({ services: [{ id: 'haircut-finish', amount: -1 }] }),
    );

    expect(e.errors.map((x) => x.field)).toStrictEqual(['services']);
  });

  it('reports `products`, not `products.1.quantity`', async () => {
    const e = await refused(
      body({
        products: [
          { id: OIL, amount: 85 },
          { id: OIL, amount: 85, quantity: 0 },
        ],
      }),
    );

    expect(e.errors.map((x) => x.field)).toStrictEqual(['products']);
  });
});

describe('one error per field', () => {
  it('collapses several broken lines in one array into one error', async () => {
    const e = await refused(
      body({
        products: [
          { id: OIL, amount: 85, quantity: 0 },
          { id: 7, amount: -1 },
        ],
      }),
    );

    expect(e.errors).toHaveLength(1);
  });

  it('still reports two DIFFERENT fields separately', async () => {
    const e = await refused(body({ products: 'oil', date: 'someday' }));

    expect(e.errors.map((x) => x.field).sort()).toStrictEqual([
      'date',
      'products',
    ]);
  });
});

describe('a body with nothing wrong with it', () => {
  it('passes through and is not touched', async () => {
    const dto = (await mobileValidationPipe().transform(
      body({ products: [{ id: OIL, amount: 85, quantity: 2 }] }),
      meta,
    )) as MobileBookingDto;

    expect(dto.salon_id).toBe('marina-walk');
    expect(dto.products).toHaveLength(1);
  });
});
