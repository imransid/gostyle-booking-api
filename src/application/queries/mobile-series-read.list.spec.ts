import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesReadHandler } from './mobile-series-read.handler';

const B1 = '11111111-1111-4111-8111-111111111111'; // a visit of an app routine
const B2 = '22222222-2222-4222-8222-222222222222'; // a visit of a desk series
const B3 = '33333333-3333-4333-8333-333333333333'; // a plain booking
const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function build() {
  const prisma = {
    booking: {
      findMany: vi.fn().mockResolvedValue([
        { id: B1, seriesId: APP },
        { id: B2, seriesId: DESK },
      ]),
    },
    bookingSeries: {
      findMany: vi.fn().mockResolvedValue([{ id: APP }]),
    },
  };
  const handler = new MobileSeriesReadHandler(
    prisma as never,
    {} as never,
    {} as never,
  );
  return { prisma, handler };
}

describe('appRoutinesOf: which visits belong to an app routine', () => {
  it('names the app routine, and leaves desk series and plain bookings out', async () => {
    const { handler } = build();
    const map = await handler.appRoutinesOf([B1, B2, B3]);
    expect([...map.entries()]).toEqual([[B1, APP]]);
  });

  it('asks the database only about app routines', async () => {
    const { handler, prisma } = build();
    await handler.appRoutinesOf([B1, B2, B3]);
    expect(prisma.bookingSeries.findMany).toHaveBeenCalledWith({
      where: { id: { in: [APP, DESK] }, source: 'mobile' },
      select: { id: true },
    });
  });

  it('does not touch the database for an empty page', async () => {
    const { handler, prisma } = build();
    expect((await handler.appRoutinesOf([])).size).toBe(0);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});

describe('bookingLinkOf (B7): what the single read adds', () => {
  const build2 = (bookingType: string | null) => {
    const prisma = {
      booking: {
        findUnique: vi
          .fn()
          .mockResolvedValue(bookingType === null ? null : { bookingType }),
        findMany: vi.fn().mockResolvedValue([
          { id: B1, seriesId: APP },
          { id: B2, seriesId: DESK },
        ]),
      },
      bookingSeries: { findMany: vi.fn().mockResolvedValue([{ id: APP }]) },
    };
    return {
      prisma,
      handler: new MobileSeriesReadHandler(
        prisma as never,
        {} as never,
        {} as never,
      ),
    };
  };

  it('a visit of an app routine: ROUTINE and its routine', async () => {
    const { handler } = build2('routine');
    expect(await handler.bookingLinkOf(B1)).toStrictEqual({
      booking_type: 'ROUTINE',
      series_id: APP,
    });
  });

  it('a desk series visit: its own type, and no routine the app can open', async () => {
    const { handler } = build2('routine');
    expect(await handler.bookingLinkOf(B2)).toStrictEqual({
      booking_type: 'ROUTINE',
      series_id: null,
    });
  });

  it('a plain booking: SINGLE and null', async () => {
    const { handler } = build2('single');
    expect(await handler.bookingLinkOf(B3)).toStrictEqual({
      booking_type: 'SINGLE',
      series_id: null,
    });
  });

  it('no such booking, or not a uuid: null, and a bad id asks nothing', async () => {
    expect(await build2(null).handler.bookingLinkOf(B3)).toBeNull();
    const { handler, prisma } = build2('single');
    expect(await handler.bookingLinkOf('nope')).toBeNull();
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
  });
});
