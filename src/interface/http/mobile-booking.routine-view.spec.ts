import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileBookingController } from './mobile-booking.controller';

/**
 * STEP B7 at the edge (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md):
 * the Recurring rows with view=booking, and booking_type and series_id on
 * the single read, only behind MOBILE_ROUTINE_CONTRACT. Off, exactly as
 * before.
 */

const actor = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'customer',
  branchId: null,
  tenantId: null,
};
const BOOKING = 'b0000000-0000-4000-8000-000000000002';
const SINGLE = {
  id: BOOKING,
  status: 'CONFIRMED_BY_SALON',
  created_at: '2026-10-01T11:00:00+06:00',
};
const PAGE = {
  count: 0,
  counts: { upcoming: 3, archive: 1, recurring: 0 },
  results: [],
};

function build(link: unknown = { booking_type: 'ROUTINE', series_id: 'S' }) {
  const handler = {
    list: vi.fn(() => Promise.resolve(PAGE)),
    read: vi.fn(() => Promise.resolve(SINGLE)),
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

describe('the single read: booking_type and series_id', () => {
  it('flag on: the two fields added at the end, nothing else changes', async () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller, series } = build();
    const answer = (await controller.read(BOOKING, actor as never)) as Record<
      string,
      unknown
    >;
    expect(answer).toStrictEqual({
      ...SINGLE,
      booking_type: 'ROUTINE',
      series_id: 'S',
    });
    expect(Object.keys(answer)).toStrictEqual([
      ...Object.keys(SINGLE),
      'booking_type',
      'series_id',
    ]);
    expect(series.bookingLinkOf).toHaveBeenCalledWith(BOOKING);
  });

  it('a single booking: SINGLE and null', async () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller } = build({ booking_type: 'SINGLE', series_id: null });
    expect(await controller.read(BOOKING, actor as never)).toMatchObject({
      booking_type: 'SINGLE',
      series_id: null,
    });
  });

  it('flag off: the booking exactly as the read gave it, and nothing is asked', async () => {
    const { controller, series } = build();
    expect(await controller.read(BOOKING, actor as never)).toBe(SINGLE);
    expect(series.bookingLinkOf).not.toHaveBeenCalled();
  });
});
