import { describe, expect, it } from 'vitest';
import type { ArgumentMetadata } from '@nestjs/common';
import { MobileGroupBookingDto } from './mobile-group-booking.controller';
import { mobileValidationPipe } from './mobile-validation.pipe';
import {
  isMobileContractError,
  type MobileFieldError,
} from '@application/commands/mobile-booking.error';

/**
 * The request shape of POST /v1/mobile-booking/group, through the same pipe
 * the controller uses: field errors come back in the app's envelope, and a
 * field nobody declared is refused rather than silently dropped.
 *
 * The party rules themselves (sizes, kinds, ids) are the contract's, pinned
 * in domain/booking/mobile-group-contract.spec.ts. This only pins what the
 * pipe decides.
 */

const meta: ArgumentMetadata = {
  type: 'body',
  metatype: MobileGroupBookingDto,
  data: '',
};

const member = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ref: 0,
  kind: 'self',
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sarah',
  age_group: 'adult',
  services: [{ id: 'haircut-finish', amount: 160 }],
  products: [],
  stylist_id: 'maya',
  ...over,
});

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    salon_id: 'marina-walk',
    start_time: '2026-10-11T15:00:00+06:00',
    members: [
      member(),
      member({
        ref: 1,
        kind: 'guest',
        id: null,
        name: 'Liam',
        age_group: 'child',
        stylist_id: null,
      }),
    ],
    amount_without_tax: 240,
    tax_amount: 12,
    discount: 0,
    promo_code: null,
    total: 252,
    deposit_percent: 20,
    advance_paid_amount: 0,
    due_amount: 252,
    payment_status: 'DRAFT',
    status: 'BOOKED',
    booking_type: 'GROUP',
    ...over,
  };
}

async function accepted(
  raw: Record<string, unknown>,
): Promise<MobileGroupBookingDto> {
  return (await mobileValidationPipe().transform(
    raw,
    meta,
  )) as MobileGroupBookingDto;
}

async function refused(
  raw: Record<string, unknown>,
): Promise<readonly MobileFieldError[]> {
  try {
    await mobileValidationPipe().transform(raw, meta);
  } catch (e) {
    if (isMobileContractError(e)) return e.errors;
    throw e;
  }
  throw new Error('expected the pipe to refuse');
}

describe('MobileGroupBookingDto', () => {
  it('accepts the app spec body, nulls and all', async () => {
    const dto = await accepted(body());
    expect(dto.members).toHaveLength(2);
    expect(dto.members[1]!.id).toBeNull();
    expect(dto.members[1]!.stylist_id).toBeNull();
  });

  it('accepts products with a quantity, and leaving deposit_percent out', async () => {
    const raw = body({
      members: [
        member({
          products: [
            {
              id: 'cccccccc-3333-4ccc-8ccc-cccccccccccc',
              amount: 25,
              quantity: 2,
            },
          ],
        }),
        member({ ref: 1, kind: 'guest', id: null, name: 'Liam' }),
      ],
    });
    delete raw.deposit_percent;
    const dto = await accepted(raw);
    expect(dto.members[0]!.products![0]!.quantity).toBe(2);
    expect(dto.deposit_percent).toBeUndefined();
  });

  it('refuses a field nobody declared, rather than dropping it', async () => {
    const errors = await refused(body({ stylists: ['maya'] }));
    expect(errors[0]!.field).toBe('stylists');
  });

  it('refuses a field nobody declared inside a member', async () => {
    const errors = await refused(
      body({ members: [member({ age: 8 }), member({ ref: 1 })] }),
    );
    expect(errors[0]!.field).toBe('members');
  });

  it('refuses money with three decimal places as amount_mismatch', async () => {
    const errors = await refused(body({ total: 252.001 }));
    expect(errors[0]).toMatchObject({
      field: 'total',
      code: 'amount_mismatch',
    });
  });

  it('refuses a start without a real instant', async () => {
    const errors = await refused(body({ start_time: 'at three' }));
    expect(errors[0]).toMatchObject({
      field: 'start_time',
      code: 'invalid_window',
    });
  });

  it('refuses a deposit percent past 100', async () => {
    const errors = await refused(body({ deposit_percent: 120 }));
    expect(errors[0]!.field).toBe('deposit_percent');
  });

  it('leaves an empty services list to the contract, which says member_no_services', async () => {
    // The pipe must NOT refuse it: its own code would be a different word
    // from the one gostyle-customer-api and the spec use.
    await expect(
      accepted(
        body({ members: [member({ services: [] }), member({ ref: 1 })] }),
      ),
    ).resolves.toBeDefined();
  });
});
