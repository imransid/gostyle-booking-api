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
