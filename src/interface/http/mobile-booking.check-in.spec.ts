import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileBookingController } from './mobile-booking.controller';

/**
 * GET /v1/mobile-booking/:id and the welcome: `check_in`, behind
 * SELF_CHECK_IN_V1. Off, the booking exactly as the handler answered it.
 */

const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const SINGLE = { id: BOOKING, status: 'CHECKED_IN' };
const LINK = { booking_type: 'ROUTINE', series_id: 'series-1' };
const actor = { id: 'sara', kind: 'customer', branchId: null, tenantId: null };

function build(welcome: unknown = null) {
  const handler = { read: vi.fn(() => Promise.resolve(SINGLE)) };
  const series = { bookingLinkOf: vi.fn(() => Promise.resolve(LINK)) };
  const checkIns = { ofBooking: vi.fn(() => Promise.resolve(welcome)) };
  const controller = new MobileBookingController(
    handler as never,
    {} as never,
    {} as never,
    series as never,
    {} as never,
    checkIns as never,
  );
  return { controller, handler, series, checkIns };
}

afterEach(() => {
  delete process.env.SELF_CHECK_IN_V1;
  delete process.env.MOBILE_ROUTINE_CONTRACT;
});

describe('GET /v1/mobile-booking/:id: the welcome', () => {
  it('flag off: the very object the handler answered, and nothing asked', async () => {
    const { controller, checkIns } = build();
    await expect(controller.read(BOOKING, actor as never)).resolves.toBe(
      SINGLE,
    );
    expect(checkIns.ofBooking).not.toHaveBeenCalled();
  });

  it('flag on: check_in in the §8 spelling, by_name and all', async () => {
    process.env.SELF_CHECK_IN_V1 = 'true';
    const { controller, checkIns } = build({
      at: '2026-10-11T10:24:00.000Z',
      via: 'STAFF',
      byName: 'Layla R.',
    });
    await expect(
      controller.read(BOOKING, actor as never),
    ).resolves.toStrictEqual({
      ...SINGLE,
      check_in: {
        at: '2026-10-11T10:24:00.000Z',
        via: 'STAFF',
        by_name: 'Layla R.',
      },
    });
    expect(checkIns.ofBooking).toHaveBeenCalledWith(BOOKING);
  });

  it('flag on, no check-in standing: check_in null, present and null', async () => {
    process.env.SELF_CHECK_IN_V1 = 'true';
    const { controller } = build(null);
    await expect(
      controller.read(BOOKING, actor as never),
    ).resolves.toStrictEqual({ ...SINGLE, check_in: null });
  });

  it('beside the routine fields: both flags, both added, neither lost', async () => {
    process.env.SELF_CHECK_IN_V1 = 'true';
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller } = build(null);
    await expect(
      controller.read(BOOKING, actor as never),
    ).resolves.toStrictEqual({ ...SINGLE, ...LINK, check_in: null });
  });

  it('the routine flag alone: as before, no check_in key at all', async () => {
    process.env.MOBILE_ROUTINE_CONTRACT = 'true';
    const { controller } = build();
    const out = await controller.read(BOOKING, actor as never);
    expect(out).toStrictEqual({ ...SINGLE, ...LINK });
    expect(out).not.toHaveProperty('check_in');
  });
});
