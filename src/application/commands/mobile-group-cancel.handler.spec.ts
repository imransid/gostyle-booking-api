import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, Logger } from '@nestjs/common';
import { MobileGroupCancelHandler } from './mobile-group-cancel.handler';
import {
  isMobileContractError,
  type MobileContractError,
} from './mobile-booking.error';
import type { GroupReader } from '@application/queries/mobile-group-read.handler';

const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';

const booker: GroupReader = {
  actorId: BOOKER,
  actorKind: 'customer',
  actorBranchId: null,
};

function harness(
  over: {
    readonly group?: unknown;
    readonly statuses?: string[];
    readonly lifecycle?: (cmd: { bookingId: string }) => Promise<unknown>;
  } = {},
) {
  const statuses = over.statuses ?? ['confirmed', 'confirmed', 'confirmed'];
  const prisma = {
    bookingGroup: {
      findUnique: vi.fn(() =>
        Promise.resolve(
          over.group !== undefined
            ? over.group
            : {
                organiserId: BOOKER,
                source: 'mobile',
                participants: statuses.map((_, i) => ({
                  bookingId: `booking-${i}`,
                })),
              },
        ),
      ),
    },
    booking: {
      findMany: vi.fn(() =>
        Promise.resolve(
          statuses.map((status, i) => ({
            id: `booking-${i}`,
            code: `GS-${1001 + i}`,
            status,
          })),
        ),
      ),
    },
  };
  const lifecycle = {
    execute: vi.fn(
      over.lifecycle ?? (() => Promise.resolve({ status: 'CANCELLED' })),
    ),
  };
  const reads = {
    read: vi.fn(() => Promise.resolve({ id: GROUP, status: 'CANCELLED' })),
  };
  const handler = new MobileGroupCancelHandler(
    prisma as never,
    lifecycle as never,
    reads as never,
  );
  const cancelled = (): string[] =>
    lifecycle.execute.mock.calls.map(
      (c) => (c as unknown as [{ bookingId: string }])[0].bookingId,
    );
  return { handler, prisma, lifecycle, reads, cancelled };
}

async function refusal(p: Promise<unknown>): Promise<MobileContractError> {
  try {
    await p;
  } catch (e) {
    if (isMobileContractError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('MobileGroupCancelHandler: only the booker (D3)', () => {
  it.each([
    [
      'a registered member of the party',
      { actorId: RANA, actorKind: 'customer', actorBranchId: null },
    ],
    [
      'staff, even of the salon',
      { actorId: BOOKER, actorKind: 'staff', actorBranchId: null },
    ],
  ])('%s is 404, never 403, and nothing is cancelled', async (_, who) => {
    const h = harness();
    const e = await refusal(h.handler.execute(GROUP, who));
    expect(e.status).toBe(404);
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });

  it('a party the desk made is 404', async () => {
    const h = harness({
      group: { organiserId: BOOKER, source: null, participants: [] },
    });
    expect((await refusal(h.handler.execute(GROUP, booker))).status).toBe(404);
  });

  it('no such party is 404', async () => {
    const h = harness({ group: null });
    expect((await refusal(h.handler.execute(GROUP, booker))).status).toBe(404);
  });

  it('a malformed id is 404 without a query', async () => {
    const h = harness();
    expect((await refusal(h.handler.execute('nope', booker))).status).toBe(404);
    expect(h.prisma.bookingGroup.findUnique).not.toHaveBeenCalled();
  });
});

describe('MobileGroupCancelHandler: the whole party, together', () => {
  it('cancels every member through the single cancel, as the customer', async () => {
    const h = harness();
    const out = await h.handler.execute(GROUP, booker);

    expect(h.cancelled()).toEqual(['booking-0', 'booking-1', 'booking-2']);
    expect(h.lifecycle.execute).toHaveBeenCalledWith({
      bookingId: 'booking-0',
      to: 'cancelled',
      actor: 'customer',
      actorId: BOOKER,
      reason: 'Cancelled by the booker, with the whole party',
      initiatedBy: 'customer',
    });
    expect(h.reads.read).toHaveBeenCalledWith(GROUP, booker);
    expect(out).toEqual({ id: GROUP, status: 'CANCELLED' });
  });

  it('skips members already gone, so a retry finishes the job', async () => {
    const h = harness({ statuses: ['cancelled', 'confirmed', 'expired'] });
    await h.handler.execute(GROUP, booker);
    expect(h.cancelled()).toEqual(['booking-1']);
  });

  it('a party already cancelled answers with the party and cancels nothing', async () => {
    const h = harness({ statuses: ['cancelled', 'cancelled'] });
    await expect(h.handler.execute(GROUP, booker)).resolves.toBeDefined();
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE party when one member cannot be cancelled, before cancelling any', async () => {
    const h = harness({ statuses: ['confirmed', 'checked_in', 'confirmed'] });
    const e = await refusal(h.handler.execute(GROUP, booker));
    expect(e.status).toBe(409);
    expect(e.errors[0]).toMatchObject({ code: 'cannot_cancel' });
    expect(e.errors[0]!.message).toContain('GS-1002');
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  });

  it('a single cancel that refuses part way is cannot_cancel, and says so', async () => {
    const h = harness({
      lifecycle: (cmd) =>
        cmd.bookingId === 'booking-1'
          ? Promise.reject(new ConflictException('This booking has moved on.'))
          : Promise.resolve({}),
    });
    const e = await refusal(h.handler.execute(GROUP, booker));
    expect(e.status).toBe(409);
    expect(e.errors[0]).toMatchObject({
      code: 'cannot_cancel',
      message: 'This booking has moved on.',
    });
    expect(h.cancelled()).toEqual(['booking-0', 'booking-1']);
  });

  it('anything that is not a refusal surfaces as itself', async () => {
    const h = harness({
      lifecycle: () => Promise.reject(new Error('db down')),
    });
    await expect(h.handler.execute(GROUP, booker)).rejects.toThrow('db down');
  });
});
