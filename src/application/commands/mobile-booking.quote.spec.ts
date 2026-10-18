import { describe, expect, it } from 'vitest';
import { MobileBookingHandler } from './mobile-booking.handler';
import { GetQuoteHandler } from '@application/queries/get-quote.handler';
import type { CustomerContext } from '@application/ports/customer-context.port';
import {
  FixtureBookingContext,
  PACKAGES,
} from '@infrastructure/fixtures/fixture-booking-context';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { MobileContractError } from './mobile-booking.error';

/**
 * POST /v1/mobile-booking/quote, against the REAL quote handler and the
 * fixture catalogue, so what is proven is the thing that matters: a create
 * built from the quote's answer is accepted. Hold and confirm are recorded,
 * not run -- they are proven elsewhere, and reaching them at all means the
 * money check passed.
 */

const CUSTOMER: CustomerContext = {
  customerId: 'cus_ayesha',
  name: 'Ayesha',
  tier: 'none',
  risk: 'LOW',
  riskScore: 80,
  isNewCustomer: false,
  requireDepositFlag: false,
  isVip: false,
};

/** 10:00 at the branch, in its own offset. */
const START = '2026-10-20T10:00:00+06:00';

function handlerWith(tier: CustomerContext['tier'] = 'none') {
  const context = new FixtureBookingContext();
  const packages = { forBranch: () => Promise.resolve(PACKAGES) };
  const customers = { load: () => Promise.resolve({ ...CUSTOMER, tier }) };
  const quotes = new GetQuoteHandler(context, customers, packages as never);

  const reached: string[] = [];
  const holds = {
    execute: () => {
      reached.push('hold');
      return Promise.resolve({ holdId: 'hold-1' });
    },
    release: () => Promise.resolve(undefined),
  };
  const confirms = {
    execute: () => {
      reached.push('confirm');
      // Stop here: the money check is what is under test.
      return Promise.reject(new Error('stop after confirm'));
    },
  };

  const handler = new MobileBookingHandler(
    holds as never,
    confirms as never,
    {} as never,
    quotes,
    {} as never,
    {} as never,
    new TenantContext(),
    {} as never,
    context,
    { enabled: () => false } as never,
    packages as never,
  );
  return { handler, reached };
}

const ask = (serviceIds: string[]) => ({
  salonId: 'marina-walk',
  serviceIds,
  products: undefined,
  date: '2026-10-20',
  startTime: START,
  customerId: 'cus_ayesha',
});

type Answer = Record<string, unknown> & {
  services: { id: string; amount: number }[];
  packages: { id: string; amount: number; savings: number }[];
  parts: { id: string; amount: number; package_id: string | null }[];
};

describe('quoting a package', () => {
  it('prices the package line at the package price', async () => {
    const { handler } = handlerWith();
    const q = (await handler.quote(ask(['colour-and-finish']))) as Answer;

    // Parts of AED 620 sold for AED 560; VAT 5% on 560.
    expect(q.services).toEqual([{ id: 'colour-and-finish', amount: 560 }]);
    expect(q.amount_without_tax).toBe(560);
    expect(q.discount).toBe(0);
    expect(q.tax_amount).toBe(28);
    expect(q.total).toBe(588);
    expect(q.due_amount).toBe(588);
    expect(q.advance_paid_amount).toBe(0);
  });

  it('says what the package saves, and what each part carries', async () => {
    const { handler } = handlerWith();
    const q = (await handler.quote(ask(['colour-and-finish']))) as Answer;

    expect(q.packages[0]).toMatchObject({
      id: 'colour-and-finish',
      amount: 560,
      parts_total: 620,
      savings: 60,
    });
    expect(q.parts.map((p) => p.id)).toEqual(['full-colour', 'blow-dry']);
    expect(q.parts.reduce((n, p) => n + p.amount, 0)).toBeCloseTo(560, 2);
    expect(q.parts.every((p) => p.package_id === 'colour-and-finish')).toBe(
      true,
    );
  });

  it('prices a hand-picked service beside it at its own price', async () => {
    const { handler } = handlerWith();
    const q = (await handler.quote(
      ask(['colour-and-finish', 'fringe-trim']),
    )) as Answer;
    expect(q.services).toEqual([
      { id: 'colour-and-finish', amount: 560 },
      { id: 'fringe-trim', amount: 60 },
    ]);
    expect(q.amount_without_tax).toBe(620);
  });

  it('takes the tier discount on the package price', async () => {
    const { handler } = handlerWith('gold');
    const q = (await handler.quote(ask(['colour-and-finish']))) as Answer;
    // Gold 10% of 560 = 56; VAT 5% of 504 = 25.20.
    expect(q.discount).toBe(56);
    expect(q.tax_amount).toBe(25.2);
    expect(q.total).toBe(529.2);
  });

  it('answers the end_time to send: the parts end to end', async () => {
    const { handler } = handlerWith();
    const q = (await handler.quote(ask(['colour-and-finish']))) as Answer;
    expect(q.duration_min).toBeGreaterThan(0);
    expect(q.start_time).toBe(START);
    expect(typeof q.end_time).toBe('string');
  });
});

describe('a create built from the quote', () => {
  it('passes the money check, for a package', async () => {
    const { handler, reached } = handlerWith();
    const q = (await handler.quote(ask(['colour-and-finish']))) as Answer;

    await expect(
      handler.execute({
        salonId: 'marina-walk',
        services: q.services,
        products: undefined,
        stylists: ['maya'],
        date: '2026-10-20',
        startTime: START,
        endTime: q.end_time as string,
        amountWithoutTax: q.amount_without_tax as number,
        taxAmount: q.tax_amount as number,
        discount: q.discount as number,
        promoCode: null,
        total: q.total as number,
        advancePaidAmount: q.advance_paid_amount as number,
        dueAmount: q.due_amount as number,
        paymentStatus: 'DRAFT',
        status: 'BOOKED',
        bookingType: 'SINGLE',
        customerId: 'cus_ayesha',
        idempotencyKey: undefined,
      }),
    ).rejects.toThrow();

    // It got past the money and the end_time checks to the hold and the
    // confirm: everything the quote said, create agreed with.
    expect(reached).toEqual(['hold', 'confirm']);
  });
});

describe('what a quote refuses', () => {
  it('an id that is neither a service nor a package', async () => {
    const { handler } = handlerWith();
    await expect(handler.quote(ask(['not-a-thing']))).rejects.toBeInstanceOf(
      MobileContractError,
    );
  });

  it('a date that is not the start_time day', async () => {
    const { handler } = handlerWith();
    await expect(
      handler.quote({ ...ask(['blow-dry']), date: '2026-10-21' }),
    ).rejects.toMatchObject({ errors: [{ code: 'date_mismatch' }] });
  });
});

describe('the basket refusals, in the contract envelope', () => {
  it('a basket mixing two currencies is currency_mismatch on services', async () => {
    const { handler } = handlerWith();
    // A package priced in taka, beside the dirham parts it is made of.
    const taka = {
      id: 'taka-pack',
      name: 'Taka pack',
      serviceIds: ['blow-dry'],
      priceFils: 10_000,
      currency: 'BDT',
    };
    (handler as unknown as { packageCatalogue: unknown }).packageCatalogue = {
      forBranch: () => Promise.resolve([taka]),
    };
    await expect(handler.quote(ask(['taka-pack']))).rejects.toMatchObject({
      errors: [{ field: 'services', code: 'currency_mismatch' }],
    });
  });
});
