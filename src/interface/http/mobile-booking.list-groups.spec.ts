import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileBookingController } from './mobile-booking.controller';
import type { Actor } from '../../auth/actor';

/**
 * GET /v1/mobile-booking with and without MOBILE_GROUP_BOOKING.
 *
 * Off, the page is the list handler's own object, not a copy: nothing about
 * My Bookings changes until the flag is turned on.
 */

const actor = {
  id: 'cus_1',
  kind: 'customer',
  branchId: null,
} as unknown as Actor;
const PAGE = { count: 1, results: [{ id: 'x' }] };
const DECORATED = {
  count: 1,
  results: [{ id: 'group', booking_type: 'GROUP' }],
};

function controller() {
  const handler = { list: vi.fn(() => Promise.resolve(PAGE)) };
  const groups = { decorateList: vi.fn(() => Promise.resolve(DECORATED)) };
  return {
    groups,
    c: new MobileBookingController(
      handler as never,
      {} as never,
      groups as never,
    ),
  };
}

afterEach(() => {
  delete process.env.MOBILE_GROUP_BOOKING;
});

describe('My Bookings and mobile parties', () => {
  it('flag off: the page is exactly what the list made', async () => {
    const { c, groups } = controller();
    expect(await c.list(actor, 'upcoming')).toBe(PAGE);
    expect(groups.decorateList).not.toHaveBeenCalled();
  });

  it('flag on: each party member row becomes the party', async () => {
    process.env.MOBILE_GROUP_BOOKING = 'true';
    const { c, groups } = controller();
    expect(await c.list(actor, 'upcoming')).toBe(DECORATED);
    expect(groups.decorateList).toHaveBeenCalledWith(PAGE);
  });
});
