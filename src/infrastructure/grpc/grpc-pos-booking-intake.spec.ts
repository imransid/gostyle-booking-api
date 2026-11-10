import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';

import { GrpcPosBookingIntake } from './grpc-pos-booking-intake';
import { PosIntakeFailure } from '@application/ports/pos-ticket-intake.port';
import type { OpenTicketForBookingRequest } from '@domain/pos/pos-ticket-request';

const KEY = 'k-platform-123';

const OPEN: OpenTicketForBookingRequest = {
  tenant_id: '0190f0c1-1111-7000-8000-000000000001',
  branch_id: '0190f0c1-3333-7000-8000-000000000003',
  booking_id: '0190f0c1-2222-7000-8000-000000000002',
  booking_code: 'GS-1234',
  start_at: '2026-11-04T10:00:00.000Z',
  opened_by_user_id: '',
  customer: { consumer_id: '', email: '', full_name: '' },
  items: [],
  products: [],
  deposit_available_minor: 0,
  deposit_vat_minor: 0,
  idempotency_key: 'booking:x:open:y',
};

function build(reply: () => Observable<unknown>) {
  const seen: Metadata[] = [];
  const call = vi.fn((_data: unknown, md: Metadata) => {
    seen.push(md);
    return reply();
  });
  const client = {
    getService: vi.fn(() => ({
      openTicketForBooking: call,
      updateBookingStatus: call,
      getTicketForBooking: call,
    })),
  };
  const adapter = new GrpcPosBookingIntake(client as never);
  adapter.onModuleInit();
  return { adapter, call, seen };
}

/** A grpc-js error as Nest hands it through, with the platform's code. */
function refusal(code: number, errorCode: string) {
  const metadata = new Metadata();
  metadata.set('error-code', errorCode);
  return Object.assign(new Error(`${errorCode}: no`), {
    code,
    details: `${errorCode}: no`,
    metadata,
  });
}

/** The rejection of a call that must fail, typed as the adapter throws it. */
async function failureOf(p: Promise<unknown>): Promise<PosIntakeFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PosIntakeFailure);
    return e as PosIntakeFailure;
  }
  throw new Error('expected the call to fail');
}

const savedKey = process.env.PLATFORM_INTERNAL_KEY;
beforeEach(() => {
  process.env.PLATFORM_INTERNAL_KEY = KEY;
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.PLATFORM_INTERNAL_KEY;
  else process.env.PLATFORM_INTERNAL_KEY = savedKey;
});

describe('GrpcPosBookingIntake', () => {
  it('sends the key as x-internal-key and maps the ticket', async () => {
    const { adapter, seen } = build(() =>
      of({
        ticket_id: '0190f0c1-0000-7000-8000-0000000000aa',
        number: '#T-42',
        state: 'OPEN',
        replayed: false,
      }),
    );
    expect(await adapter.openTicketForBooking(OPEN)).toEqual({
      ticketId: '0190f0c1-0000-7000-8000-0000000000aa',
      number: '#T-42',
      state: 'OPEN',
      replayed: false,
    });
    expect(seen[0]!.get('x-internal-key')).toEqual([KEY]);
  });

  it('refuses locally, sending nothing, when the key is not set', async () => {
    process.env.PLATFORM_INTERNAL_KEY = '  ';
    const { adapter, call } = build(() => of({}));
    const err = await failureOf(adapter.openTicketForBooking(OPEN));
    expect(err).toBeInstanceOf(PosIntakeFailure);
    expect(err.grpcStatus).toBeNull();
    expect(err.errorCode).toBe('PLATFORM_INTERNAL_KEY_UNSET');
    expect(call).not.toHaveBeenCalled();
  });

  it('carries the status name and the platform code of a refusal', async () => {
    const { adapter } = build(() =>
      throwError(() => refusal(status.FAILED_PRECONDITION, 'POS_Z_IMMUTABLE')),
    );
    const err = await failureOf(adapter.openTicketForBooking(OPEN));
    expect(err).toBeInstanceOf(PosIntakeFailure);
    expect(err.grpcStatus).toBe('FAILED_PRECONDITION');
    expect(err.errorCode).toBe('POS_Z_IMMUTABLE');
  });

  it('treats an answer with no ticket as no verdict', async () => {
    const { adapter } = build(() => of({ ticket_id: '' }));
    const err = await failureOf(adapter.openTicketForBooking(OPEN));
    expect(err.grpcStatus).toBe('INTERNAL');
  });

  it('reads a paid ticket back for the safety net', async () => {
    const { adapter } = build(() =>
      of({
        found: true,
        ticket_id: '0190f0c1-0000-7000-8000-0000000000aa',
        number: '#T-42',
        state: 'PAID',
        paid_at: '2026-11-04T11:00:00.000Z',
        cashier_id: '0190f0c1-0000-7000-8000-0000000000cc',
        total_minor: 21000,
        deposit_applied_minor: 5000,
        deposit_applied_vat_minor: 238,
        documents: [
          { type: 'RECEIPT', number: 'R-118' },
          { type: 'INVOICE', number: '' },
        ],
      }),
    );
    expect(
      await adapter.getTicketForBooking(OPEN.tenant_id, OPEN.booking_id),
    ).toEqual({
      found: true,
      ticketId: '0190f0c1-0000-7000-8000-0000000000aa',
      number: '#T-42',
      state: 'PAID',
      paidAt: '2026-11-04T11:00:00.000Z',
      cashierId: '0190f0c1-0000-7000-8000-0000000000cc',
      totalMinor: 21000,
      depositAppliedMinor: 5000,
      depositAppliedVatMinor: 238,
      documents: [{ type: 'RECEIPT', number: 'R-118' }],
    });
  });
});
