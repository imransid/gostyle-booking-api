import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileBookingController } from './mobile-booking.controller';

/**
 * STEP B7 at the edge (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md):
 * the Recurring rows with view=booking, and series_id on the single read,
 * only behind MOBILE_ROUTINE_CONTRACT. Off, exactly as before.
 *
 * booking_type is NOT behind it: it is a fact of the booking row, on the
 * handler's own shape (present()), so the read carries it with the flag off.
 */

const actor = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'customer',
  branchId: null,
  tenantId: null,
};
const BOOKING = 'b0000000-0000-4000-8000-000000000002';
// The handler's answer: booking_type is its own, from the row.
const SINGLE = {
  id: BOOKING,
  status: 'CONFIRMED_BY_SALON',
  booking_type: 'SINGLE',
  created_at: '2026-10-01T11:00:00+06:00',
};
const ROUTINE_VISIT = { ...SINGLE, booking_type: 'ROUTINE' };
const PAGE = {
  count: 0,
  counts: { upcoming: 3, archive: 1, recurring: 0 },
  results: [],
};

function build(
  link: unknown = { booking_type: 'ROUTINE', series_id: 'S' },
  read: unknown = ROUTINE_VISIT,
) {
  const handler = {
    list: vi.fn(() => Promise.resolve(PAGE)),
    read: vi.fn(() => Promise.resolve(read)),
  };
  const series = {
    listForCustomer: vi.fn(() =>
      Promise.resolve({ count: 1, results: [{ id: 'row' }] }),
    ),
    countForCustomer: vi.fn(() => Promise.resolve(1)),
    appRoutinesOf: vi.fn(() => Promise.resolve(new Map())),
    bookingLinkOf: vi.fn(() => Promise.resolve(link)),
  };
  const bookingView = {
    list: vi.fn(() =>
      Promise.resolve({ count: 1, results: [{ id: 'booking' }] }),
    ),
  };
  const controller = new MobileBookingController(
    handler as never,
    {} as never,
    { decorateList: vi.fn() } as never,
    series as never,
    bookingView as never,
  );
  return { controller, handler, series, bookingView };
}

afterEach(() => {
  delete process.env.MOBILE_ROUTINE_CONTRACT;
  delete process.env.MOBILE_SERIES_BOOKING;
});

describe('the Recurring rows, view=booking', () => {
  it('flag on: each routine as one booking, the count as before', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller, series, bookingView } = build();
    const page = await controller.list(
      actor as never,
      'recurring',
      '1',
      '20',
      'booking',
    );
    expect(page).toStrictEqual({
      count: 1,
      counts: { upcoming: 3, archive: 1, recurring: 1 },
      results: [{ id: 'booking' }],
    });
    expect(bookingView.list).toHaveBeenCalledWith(actor.id, {
      page: 1,
      pageSize: 20,
    });
    expect(series.listForCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ['flag off, view=booking', undefined, 'booking'],
    ['flag on, no view', 'true', undefined],
    ['flag on, another view', 'true', 'rows'],
  ] as const)(
    '%s: the routine rows, exactly as before',
    async (_n, flag, view) => {
      process.env.MOBILE_SERIES_BOOKING = 'true';
      if (flag !== undefined) process.env.MOBILE_ROUTINE_CONTRACT = flag;
      const { controller, series, bookingView } = build();
      const page = await controller.list(
        actor as never,
        'recurring',
        '1',
        '20',
        view,
      );
      expect(page).toStrictEqual({
        count: 1,
        counts: { upcoming: 3, archive: 1, recurring: 1 },
        results: [{ id: 'row' }],
      });
      expect(series.listForCustomer).toHaveBeenCalled();
      expect(bookingView.list).not.toHaveBeenCalled();
    },
  );

  it('view=booking on another shelf changes nothing', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller, bookingView } = build();
    await controller.list(actor as never, 'upcoming', '1', '20', 'booking');
    expect(bookingView.list).not.toHaveBeenCalled();
  });
});

describe('the single read: booking_type always, series_id behind the flag', () => {
  it('flag on: series_id added at the end; booking_type where the read put it, the same value', async () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller, series } = build();
    const answer = (await controller.read(BOOKING, actor as never)) as Record<
      string,
      unknown
    >;
    expect(answer).toStrictEqual({ ...ROUTINE_VISIT, series_id: 'S' });
    expect(Object.keys(answer)).toStrictEqual([
      ...Object.keys(ROUTINE_VISIT),
      'series_id',
    ]);
    expect(series.bookingLinkOf).toHaveBeenCalledWith(BOOKING);
  });

  it('a single booking, flag on: SINGLE and null', async () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller } = build(
      { booking_type: 'SINGLE', series_id: null },
      SINGLE,
    );
    expect(await controller.read(BOOKING, actor as never)).toStrictEqual({
      ...SINGLE,
      series_id: null,
    });
  });

  it('flag off: booking_type, from the read itself, and no series_id; nothing extra is asked', async () => {
    const { controller, series } = build(undefined, SINGLE);
    const answer = await controller.read(BOOKING, actor as never);
    expect(answer).toBe(SINGLE);
    expect(answer).toHaveProperty('booking_type', 'SINGLE');
    expect(answer).not.toHaveProperty('series_id');
    expect(series.bookingLinkOf).not.toHaveBeenCalled();
  });
});
