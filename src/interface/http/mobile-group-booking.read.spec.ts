import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileGroupBookingController } from './mobile-group-booking.controller';
import type { Actor } from '../../auth/actor';

/**
 * GET /v1/mobile-booking/group/:groupId with and without
 * MOBILE_GROUP_SELF_CHECK_IN.
 *
 * Off, the read is called exactly as before, with no viewer, and its answer
 * goes out as it came.
 */

const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const actor = {
  id: 'cus_1',
  kind: 'customer',
  branchId: null,
} as unknown as Actor;
const WHO = { actorId: 'cus_1', actorKind: 'customer', actorBranchId: null };
const PARTY = { id: GROUP, booking_type: 'GROUP' };

function controller() {
  const reads = { read: vi.fn(() => Promise.resolve(PARTY)) };
  return {
    reads,
    c: new MobileGroupBookingController(
      {} as never,
      reads as never,
      {} as never,
    ),
  };
}

afterEach(() => {
  delete process.env.MOBILE_GROUP_SELF_CHECK_IN;
  delete process.env.MOBILE_GROUP_CHECK_IN;
  delete process.env.MOBILE_GROUP_CHAIRS;
  delete process.env.MOBILE_GROUP_LIVE_STATUS;
});

describe('The party read and who is looking', () => {
  it('flag off: the read gets no viewer, and its answer goes out as it came', async () => {
    const { c, reads } = controller();
    expect(await c.read(GROUP, actor)).toBe(PARTY);
    expect(reads.read.mock.calls).toEqual([[GROUP, WHO]]);
    expect(reads.read.mock.calls[0]).toHaveLength(2);
  });

  it('flag on: the caller is passed, for is_me', async () => {
    process.env.MOBILE_GROUP_SELF_CHECK_IN = 'true';
    const { c, reads } = controller();
    expect(await c.read(GROUP, actor)).toBe(PARTY);
    expect(reads.read.mock.calls).toEqual([[GROUP, WHO, 'cus_1']]);
  });

  it('MOBILE_GROUP_CHECK_IN alone does not pass the caller', async () => {
    process.env.MOBILE_GROUP_CHECK_IN = 'true';
    const { c, reads } = controller();
    await c.read(GROUP, actor);
    expect(reads.read.mock.calls[0]).toHaveLength(2);
  });
});

describe('The party read, the chairs and the live status', () => {
  it('both off: called exactly as before, with no extras', async () => {
    const { c, reads } = controller();
    await c.read(GROUP, actor);
    expect(reads.read.mock.calls).toEqual([[GROUP, WHO]]);
  });

  it('MOBILE_GROUP_CHAIRS on: the chairs are asked for, and nothing else', async () => {
    process.env.MOBILE_GROUP_CHAIRS = 'true';
    const { c, reads } = controller();
    expect(await c.read(GROUP, actor)).toBe(PARTY);
    expect(reads.read.mock.calls).toEqual([
      [GROUP, WHO, undefined, { chairs: true }],
    ]);
  });

  it('MOBILE_GROUP_LIVE_STATUS on: the live status is asked for, and nothing else', async () => {
    process.env.MOBILE_GROUP_LIVE_STATUS = 'true';
    const { c, reads } = controller();
    await c.read(GROUP, actor);
    expect(reads.read.mock.calls).toEqual([
      [GROUP, WHO, undefined, { liveStatus: true }],
    ]);
  });

  it('all three on: the viewer and both extras', async () => {
    process.env.MOBILE_GROUP_SELF_CHECK_IN = 'true';
    process.env.MOBILE_GROUP_CHAIRS = 'true';
    process.env.MOBILE_GROUP_LIVE_STATUS = 'true';
    const { c, reads } = controller();
    await c.read(GROUP, actor);
    expect(reads.read.mock.calls).toEqual([
      [GROUP, WHO, 'cus_1', { chairs: true, liveStatus: true }],
    ]);
  });
});
