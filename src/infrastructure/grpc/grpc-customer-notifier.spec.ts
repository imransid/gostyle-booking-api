import { afterEach, describe, it, expect, vi } from 'vitest';
import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';
import { Logger } from '@nestjs/common';
import { GrpcCustomerNotifier, outcomeOf } from './grpc-customer-notifier';
import type { NotifyRequest } from '@application/ports/customer-notifier.port';

const REQUEST: NotifyRequest = {
  consumerId: '22222222-2222-4222-8222-222222222222',
  type: 'booking.cancelled',
  dedupeKey: 'booking.cancelled:b-1',
  params: {
    booking_id: 'b-1',
    booking_code: 'GS-1',
    branch_id: 'br-1',
    start_at: '2026-11-02T07:00:00.000Z',
  },
  targetType: 'booking',
  targetId: 'b-1',
  deliverBy: '2026-11-01T08:00:00.000Z',
};

function build(
  reply: () => Observable<unknown>,
  leadsReply: (data: { consumer_ids: string[] }) => Observable<unknown> = () =>
    of({ leads: {} }),
) {
  const notify = vi.fn((_data: unknown, _md: Metadata, _opts: unknown) =>
    reply(),
  );
  const getReminderLeads = vi.fn(
    (data: { consumer_ids: string[] }, _md: Metadata, _opts: unknown) =>
      leadsReply(data),
  );
  const client = { getService: vi.fn(() => ({ notify, getReminderLeads })) };
  const adapter = new GrpcCustomerNotifier(client as never);
  adapter.onModuleInit();
  return { adapter, notify, getReminderLeads };
}

const grpcError = (code: number, details = '') =>
  Object.assign(new Error(details), { code, details });

const savedKey = process.env.INTERNAL_GRPC_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.INTERNAL_GRPC_KEY;
  else process.env.INTERNAL_GRPC_KEY = savedKey;
  vi.restoreAllMocks();
});

describe('GrpcCustomerNotifier', () => {
  it('sends the facts snake_case, with the key, as booking-api', async () => {
    process.env.INTERNAL_GRPC_KEY = 'k-123';
    const { adapter, notify } = build(() =>
      of({ outcome: 'ACCEPTED', notification_id: 'n-1' }),
    );

    expect(await adapter.notify(REQUEST)).toEqual({
      kind: 'sent',
      ref: 'accepted:n-1',
    });

    const [wire, md] = notify.mock.calls[0]!;
    expect(wire).toEqual({
      consumer_id: REQUEST.consumerId,
      type: 'booking.cancelled',
      dedupe_key: 'booking.cancelled:b-1',
      params: REQUEST.params,
      target_type: 'booking',
      target_id: 'b-1',
      source: 'booking-api',
      deliver_by: '2026-11-01T08:00:00.000Z',
    });
    expect(md.get('x-internal-key')).toEqual(['k-123']);
  });

  it('INVALID_ARGUMENT fails for good', async () => {
    const { adapter } = build(() =>
      throwError(() => grpcError(status.INVALID_ARGUMENT, 'unknown type')),
    );
    expect((await adapter.notify(REQUEST)).kind).toBe('failed');
  });

  it.each([
    ['UNAVAILABLE', status.UNAVAILABLE],
    ['DEADLINE_EXCEEDED', status.DEADLINE_EXCEEDED],
    ['UNKNOWN (its database dropped)', status.UNKNOWN],
    [
      'UNIMPLEMENTED (customer-api not deployed with Notify)',
      status.UNIMPLEMENTED,
    ],
    ['UNAUTHENTICATED (the key)', status.UNAUTHENTICATED],
  ])('%s is a retry', async (_name, code) => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { adapter } = build(() => throwError(() => grpcError(code, 'nope')));
    expect((await adapter.notify(REQUEST)).kind).toBe('retry');
  });

  it('makes one attempt: the dispatcher does the retrying', async () => {
    const { adapter, notify } = build(() =>
      throwError(() => grpcError(status.UNAVAILABLE, 'refused')),
    );
    await adapter.notify(REQUEST);
    expect(notify).toHaveBeenCalledOnce();
  });
});

describe('outcomeOf', () => {
  it.each([
    [
      { outcome: 'ACCEPTED', notification_id: 'n-1' },
      { kind: 'sent', ref: 'accepted:n-1' },
    ],
    [
      { outcome: 'DUPLICATE', notification_id: 'n-1' },
      { kind: 'sent', ref: 'duplicate:n-1' },
    ],
    [{ outcome: 'SUPPRESSED' }, { kind: 'sent', ref: 'suppressed' }],
    [
      { outcome: 'NOT_FOUND' },
      { kind: 'skipped', reason: 'customer_not_found' },
    ],
  ])('%o', (reply, expected) => {
    expect(outcomeOf(reply)).toEqual(expected);
  });

  it('an outcome this build does not know is asked again later', () => {
    expect(outcomeOf({ outcome: 'OUTCOME_UNSPECIFIED' }).kind).toBe('retry');
    expect(outcomeOf({}).kind).toBe('retry');
  });
});

describe('leads (GetReminderLeads)', () => {
  it("reads each customer's switch and time; a missing one is not there", async () => {
    const { adapter } = build(
      () => of({}),
      () => of({ leads: { c1: { enabled: true, lead_minutes: 30 }, c2: {} } }),
    );
    const got = await adapter.leads(['c1', 'c2', 'c3']);
    expect(got.kind).toBe('answered');
    if (got.kind !== 'answered') return;
    expect(got.leads.get('c1')).toEqual({ enabled: true, leadMinutes: 30 });
    // proto3 left false and 0 off the wire: not a choice.
    expect(got.leads.get('c2')).toEqual({ enabled: false, leadMinutes: 0 });
    expect(got.leads.has('c3')).toBe(false);
  });

  it('asks in batches of 1000, each id once', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `c${i}`);
    const { adapter, getReminderLeads } = build(() => of({}));
    await adapter.leads([...ids, 'c1']);
    expect(
      getReminderLeads.mock.calls.map(([d]) => d.consumer_ids.length),
    ).toEqual([1000, 1000, 500]);
  });

  it('no answer is unavailable, never half an answer', async () => {
    const { adapter } = build(
      () => of({}),
      () => throwError(() => grpcError(status.UNAVAILABLE, 'refused')),
    );
    expect((await adapter.leads(['c1'])).kind).toBe('unavailable');
  });
});
