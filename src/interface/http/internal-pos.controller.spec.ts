import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import {
  InternalPosController,
  type PosTicketPaidDto,
} from './internal-pos.controller';
import { hmacSha256Hex } from '@infrastructure/security/hmac';

const BODY: PosTicketPaidDto = {
  tenantId: '0190f0c1-1111-7000-8000-000000000001',
  bookingId: '0190f0c1-2222-7000-8000-000000000002',
  ticketId: '0190f0c1-0000-7000-8000-0000000000aa',
  ticketNumber: '#T-42',
  paidAt: '2026-11-04T11:00:00.000Z',
  cashierId: '0190f0c1-0000-7000-8000-0000000000cc',
  totalMinor: 21000,
  depositAppliedMinor: 5000,
  depositAppliedVatMinor: 238,
  documents: [{ type: 'RECEIPT', number: 'R-118' }],
};
// The exact bytes the platform sent, key order and all.
const RAW = JSON.stringify(BODY);

function setup() {
  const paid = {
    settle: vi.fn(() =>
      Promise.resolve({
        bookingId: BODY.bookingId,
        code: 'GS-1234',
        status: 'settled',
        alreadySettled: false,
      }),
    ),
  };
  return { controller: new InternalPosController(paid as never), paid };
}

const saved = {
  secret: process.env.POS_CALLBACK_SECRET,
  env: process.env.NODE_ENV,
};
beforeEach(() => {
  process.env.POS_CALLBACK_SECRET = 'shared-secret';
});
afterEach(() => {
  for (const [k, v] of [
    ['POS_CALLBACK_SECRET', saved.secret],
    ['NODE_ENV', saved.env],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('POST /v1/internal/pos/ticket-paid', () => {
  it('settles on a signature over the raw body', async () => {
    const { controller, paid } = setup();
    const out = await controller.ticketPaid(
      BODY,
      hmacSha256Hex('shared-secret', RAW),
      { rawBody: Buffer.from(RAW) },
    );
    expect(out.status).toBe('settled');
    expect(paid.settle).toHaveBeenCalledWith({
      ...BODY,
      documents: [{ type: 'RECEIPT', number: 'R-118' }],
    });
  });

  it('refuses a wrong signature, a missing one, or one over other bytes', async () => {
    const { controller, paid } = setup();
    const raw = { rawBody: Buffer.from(RAW) };
    await expect(
      controller.ticketPaid(BODY, hmacSha256Hex('other', RAW), raw),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.ticketPaid(BODY, undefined, raw),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.ticketPaid(
        BODY,
        hmacSha256Hex('shared-secret', `${RAW} `),
        raw,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(paid.settle).not.toHaveBeenCalled();
  });

  it('fails closed in production with no secret', async () => {
    delete process.env.POS_CALLBACK_SECRET;
    process.env.NODE_ENV = 'production';
    const { controller, paid } = setup();
    await expect(
      controller.ticketPaid(BODY, hmacSha256Hex('', RAW), {
        rawBody: Buffer.from(RAW),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(paid.settle).not.toHaveBeenCalled();
  });
});

describe('PosTicketPaidDto validation', () => {
  /**
   * THE FIRST LIVE RUN'S BUG. The platform's seeded tenant is
   * 00000000-0000-0000-0000-000000000001, which carries no RFC 4122 version
   * nibble, and @IsUUID() refused every paid callback for it with a 400 the
   * platform retried until it gave up.
   */
  it("accepts the platform's own ids, versioned or not", async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { PosTicketPaidDto: Dto } = await import('./internal-pos.controller');
    const dto = plainToInstance(Dto, {
      ...BODY,
      tenantId: '00000000-0000-0000-0000-000000000001',
    });
    expect(await validate(dto)).toEqual([]);
  });

  it('still refuses something that is not an id at all', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { PosTicketPaidDto: Dto } = await import('./internal-pos.controller');
    const errors = await validate(
      plainToInstance(Dto, { ...BODY, tenantId: 'not-a-tenant' }),
    );
    expect(errors.map((e) => e.property)).toEqual(['tenantId']);
  });
});
