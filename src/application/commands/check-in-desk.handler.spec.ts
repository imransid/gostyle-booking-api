import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  CheckInDeskHandler,
  RECEPTION_NAMES_CAP_MS,
  RECEPTION_NAME_LOOKUP_MS,
} from './check-in-desk.handler';
import { BookingError } from '@application/contract/errors';

const RAISED = new Date('2026-10-11T03:50:00.000Z');
const DECIDED = new Date('2026-10-11T03:55:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  bookingId: 'booking-1',
  state: 'approved',
  raisedAt: RAISED,
  raisedByKind: 'customer',
  decidedAt: DECIDED,
  decidedByKind: 'staff',
  decidedById: 'desk-uuid',
  reason: null,
  ...over,
});
const CHECKED_IN = { code: 'GS-1', from: 'CONFIRMED', to: 'CHECKED_IN' };

function handler(
  repo: Record<string, unknown>,
  lookup: (id: string) => Promise<unknown> = () =>
    Promise.resolve({ kind: 'not_found' }),
) {
  const lifecycle = { execute: vi.fn(() => Promise.resolve(CHECKED_IN)) };
  const contacts = { lookup: vi.fn(lookup) };
  return {
    h: new CheckInDeskHandler(
      repo as never,
      lifecycle as never,
      contacts as never,
    ),
    lifecycle,
    contacts,
  };
}

const caught = async (p: Promise<unknown>): Promise<BookingError> => {
  const e: unknown = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(BookingError);
  return e as BookingError;
};

describe('approve', () => {
  it('runs the EXISTING check-in, as this desk, inside approveWith', async () => {
    const approveWith = vi.fn(
      async (_input: unknown, checkIn: () => Promise<unknown>) => ({
        kind: 'approved',
        request: row(),
        checkIn: await checkIn(),
      }),
    );
    const { h, lifecycle } = handler({ approveWith });
    const out = await h.approve({
      bookingId: 'booking-1',
      actor: 'staff',
      actorId: 'desk-1',
    });
    expect(lifecycle.execute).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      to: 'checked_in',
      actor: 'staff',
      actorId: 'desk-1',
    });
    expect(approveWith).toHaveBeenCalledWith(
      { bookingId: 'booking-1', deciderKind: 'staff', deciderId: 'desk-1' },
      expect.any(Function),
    );
    expect(out).toEqual({
      request: {
        requestId: 'req-1',
        bookingId: 'booking-1',
        state: 'APPROVED',
        raisedAt: RAISED.toISOString(),
        decidedAt: DECIDED.toISOString(),
        decidedByKind: 'STAFF',
        decidedById: 'desk-uuid',
        reason: null,
      },
      checkIn: CHECKED_IN,
    });
  });

  it('nothing waiting: BOOKING_STATE_INVALID with the latest state', async () => {
    const { h } = handler({
      approveWith: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: 'expired' }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_STATE_INVALID', 409]);
    expect(e.details).toEqual({ request: 'EXPIRED' });
  });

  it('never raised: details.request is null', async () => {
    const { h } = handler({
      approveWith: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: null }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect(e.details).toEqual({ request: null });
  });

  it('no booking: BOOKING_NOT_FOUND', async () => {
    const { h } = handler({
      approveWith: () => Promise.resolve({ kind: 'not_found' }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_NOT_FOUND', 404]);
  });
});

describe('reject', () => {
  it('trims the reason and hands it down; the desk sees it back', async () => {
    const reject = vi.fn(() =>
      Promise.resolve({
        kind: 'rejected',
        request: row({ state: 'rejected', reason: 'Not at the salon' }),
      }),
    );
    const { h, lifecycle } = handler({ reject });
    const out = await h.reject({
      bookingId: 'booking-1',
      actor: 'manager',
      actorId: 'desk-2',
      reason: '  Not at the salon  ',
    });
    expect(reject).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      deciderKind: 'manager',
      deciderId: 'desk-2',
      reason: 'Not at the salon',
    });
    expect(out.request).toMatchObject({
      state: 'REJECTED',
      reason: 'Not at the salon',
    });
    expect(lifecycle.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'reason %j: BOOKING_REASON_REQUIRED, and nothing is written',
    async (reason) => {
      const reject = vi.fn();
      const { h } = handler({ reject });
      const e = await caught(
        h.reject({ bookingId: 'b', actor: 'staff', actorId: 'd', reason }),
      );
      expect([e.code, e.status, e.message]).toEqual([
        'BOOKING_REASON_REQUIRED',
        422,
        'Choose a reason',
      ]);
      expect(reject).not.toHaveBeenCalled();
    },
  );

  it('nothing waiting: BOOKING_STATE_INVALID', async () => {
    const { h } = handler({
      reject: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: 'approved' }),
    });
    const e = await caught(
      h.reject({ bookingId: 'b', actor: 'staff', actorId: 'd', reason: 'x' }),
    );
    expect(e.details).toEqual({ request: 'APPROVED' });
  });
});

describe('reception', () => {
  it('each line carries its booking for the scope check, apart from what is shown', async () => {
    const booking = {
      id: 'booking-1',
      code: 'GS-1',
      status: 'confirmed',
      startAt: new Date('2026-10-11T04:00:00.000Z'),
      endAt: new Date('2026-10-11T05:00:00.000Z'),
      customerId: 'cust-1',
      tenantId: 'tenant-a',
      branchId: 'branch-a',
    };
    const listForBranch = vi.fn(() =>
      Promise.resolve({
        waiting: [{ request: row({ state: 'waiting' }), booking }],
        needsDecision: [],
      }),
    );
    const { h } = handler({ listForBranch });
    const out = await h.reception('marina-walk');
    expect(listForBranch).toHaveBeenCalledWith(
      'marina-walk',
      expect.any(Number),
    );
    expect(out.needsDecision).toEqual([]);
    expect(out.waiting[0]?.scope).toEqual({
      customerId: 'cust-1',
      tenantId: 'tenant-a',
      branchId: 'branch-a',
    });
    expect(out.waiting[0]?.item.booking).toEqual({
      bookingId: 'booking-1',
      code: 'GS-1',
      status: 'CONFIRMED',
      startAt: '2026-10-11T04:00:00.000Z',
      endAt: '2026-10-11T05:00:00.000Z',
      customerId: 'cust-1',
      customerName: null,
    });
    expect(JSON.stringify(out.waiting[0]?.item)).not.toContain('tenant-a');
  });
});

describe('named: the customer\u2019s name, and the list never waits for it', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const item = (customerId: string, code = 'GS-1') => ({
    request: {} as never,
    booking: {
      bookingId: `b-${code}`,
      code,
      status: 'CONFIRMED' as const,
      startAt: '2026-10-11T04:00:00.000Z',
      endAt: '2026-10-11T05:00:00.000Z',
      customerId,
      customerName: null,
    },
  });
  const found = (fullName: string | null) => ({
    kind: 'found',
    contact: { fullName, email: 'never@shown.example' },
  });
  const warnings = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  it('names each line, asking once per DISTINCT customer, in quick mode', async () => {
    const { h, contacts } = handler({}, (id) =>
      Promise.resolve(found(id === 'sara' ? 'Sara Ahmed' : 'Omar Saleh')),
    );
    const page = await h.named({
      waiting: [item('sara', 'GS-1'), item('omar', 'GS-2')],
      needsDecision: [item('sara', 'GS-3'), item('sara', 'GS-4')],
    });
    expect(contacts.lookup).toHaveBeenCalledTimes(2);
    expect(contacts.lookup).toHaveBeenCalledWith('sara', {
      quickMs: RECEPTION_NAME_LOOKUP_MS,
    });
    expect(page.waiting.map((i) => i.booking.customerName)).toEqual([
      'Sara Ahmed',
      'Omar Saleh',
    ]);
    expect(page.needsDecision.map((i) => i.booking.customerName)).toEqual([
      'Sara Ahmed',
      'Sara Ahmed',
    ]);
    expect(JSON.stringify(page)).not.toContain('never@shown.example');
  });

  it('100 lines, 100 customers, customer-api UNAVAILABLE: the list returns, every name null, ONE log line', async () => {
    const warn = warnings();
    const { h, contacts } = handler({}, () =>
      Promise.resolve({
        kind: 'unavailable',
        error: 'customer-api UNAVAILABLE: connection refused',
      }),
    );
    const lines = Array.from({ length: 100 }, (_, n) =>
      item(`customer-${n}`, `GS-${n}`),
    );

    const page = await h.named({ waiting: [], needsDecision: lines });

    expect(contacts.lookup).toHaveBeenCalledTimes(100);
    expect(page.needsDecision).toHaveLength(100);
    expect(
      page.needsDecision.every((i) => i.booking.customerName === null),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      'names: customer-api unavailable for 100 of 100 customer(s) ' +
        '(customer-api UNAVAILABLE: connection refused); those names are null',
    );
  });

  it('customer-api never answers: the list goes out at the cap, names null, ONE log line', async () => {
    vi.useFakeTimers();
    const warn = warnings();
    const { h } = handler({}, () => new Promise(() => undefined));
    const lines = Array.from({ length: 30 }, (_, n) =>
      item(`c-${n}`, `GS-${n}`),
    );

    let done = false;
    const out = h
      .named({ waiting: lines, needsDecision: [] })
      .then((p) => ((done = true), p));

    await vi.advanceTimersByTimeAsync(RECEPTION_NAMES_CAP_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const page = await out;

    expect(page.waiting.every((i) => i.booking.customerName === null)).toBe(
      true,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      'names: customer-api did not answer 30 lookup(s) within 1000ms; ' +
        'the list went out without them',
    );
  });

  it('a lookup that throws counts as unavailable, and the rest still name', async () => {
    const warn = warnings();
    const { h } = handler({}, (id) =>
      id === 'broken'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(found('Sara Ahmed')),
    );
    const page = await h.named({
      waiting: [item('sara'), item('broken', 'GS-2')],
      needsDecision: [],
    });
    expect(page.waiting.map((i) => i.booking.customerName)).toEqual([
      'Sara Ahmed',
      null,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('not found (a guest, a deleted account) is null, and not worth a log line', async () => {
    const warn = warnings();
    const { h } = handler({}, () => Promise.resolve({ kind: 'not_found' }));
    const page = await h.named({ waiting: [item('ghost')], needsDecision: [] });
    expect(page.waiting[0]?.booking.customerName).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('an empty page asks nothing', async () => {
    const { h, contacts } = handler({});
    await h.named({ waiting: [], needsDecision: [] });
    expect(contacts.lookup).not.toHaveBeenCalled();
  });
});
