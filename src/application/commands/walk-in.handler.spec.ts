import { describe, expect, it } from 'vitest';
import { WalkInHandler } from './walk-in.handler';
import {
  FixtureBookingContext,
  PACKAGES,
} from '@infrastructure/fixtures/fixture-booking-context';
import type {
  JoinWalkInInput,
  WalkInRow,
} from '@infrastructure/persistence/walk-in.repository';
import {
  toUuid,
  type PlaceHoldInput,
  type ResourceDemand,
} from '@infrastructure/persistence/hold.repository';

/**
 * A PACKAGE IN THE QUEUE IS STILL A PACKAGE AT THE DESK.
 *
 * The queue stored the expansion, so the seat handed the desk the parts and
 * the desk confirmed the parts: the package price was gone before the
 * booking existed. And the seat held the LAST part's station for the whole
 * visit. Run against the fixture catalogue, which is a real
 * BookingContextReader with real chains.
 */

function handlerWith(queued: readonly string[] = ['colour-and-finish']) {
  const joined: JoinWalkInInput[] = [];
  const placed: PlaceHoldInput[] = [];

  const row: WalkInRow = {
    walkIn: {
      id: 'walk-1',
      label: 'Sara',
      serviceIds: queued,
      durationMin: 170,
      joinedMin: 600,
    },
    customerId: null,
    guestName: 'Sara',
  };

  const repo = {
    join: (input: JoinWalkInInput) => {
      joined.push(input);
      return Promise.resolve({ id: 'walk-1', position: 1 });
    },
    find: () => Promise.resolve(row),
    // As the column holds it: the demo salon's slug folded through toUuid.
    entryContext: () =>
      Promise.resolve({
        branchId: toUuid('marina-walk'),
        tradingDay: '2026-10-19',
      }),
    markHeld: () => Promise.resolve(),
  };
  const holds = {
    place: (input: PlaceHoldInput) => {
      placed.push(input);
      return Promise.resolve({
        kind: 'held' as const,
        holdId: 'hold-1',
        expiresAt: new Date('2026-10-19T10:05:00Z'),
      });
    },
  };
  const askedFor: string[] = [];
  const packages = {
    forBranch: (branchId: string) => {
      askedFor.push(branchId);
      return Promise.resolve(PACKAGES);
    },
  };

  const handler = new WalkInHandler(
    repo as never,
    holds as never,
    new FixtureBookingContext(),
    {} as never,
    packages as never,
  );
  return { handler, joined, placed, askedFor };
}

const join = {
  branchId: 'marina-walk',
  tradingDay: '2026-10-19',
  customerId: null,
  guestName: 'Sara',
  serviceIds: ['colour-and-finish'],
  joinedMin: 600,
};

describe('joining the queue with a package', () => {
  it('stores what was asked for, the package itself', async () => {
    const { handler, joined } = handlerWith();
    await handler.join(join);
    expect(joined[0]!.serviceIds).toEqual(['colour-and-finish']);
  });

  it('times the visit from the parts', async () => {
    const { handler, joined } = handlerWith();
    await handler.join(join);
    // full-colour 125 + blow-dry 45.
    expect(joined[0]!.durationMin).toBe(170);
  });

  it('still answers with the parts, as it always has', async () => {
    const { handler } = handlerWith();
    const out = await handler.join(join);
    expect(out.serviceIds).toEqual(['full-colour', 'blow-dry']);
  });
});

describe('seating a queued package', () => {
  it('asks for the packages of the branch it was written for, not its hash', async () => {
    // The column holds toUuid('marina-walk'); read as it is, the demo salon
    // looked like a real platform branch and seating asked the platform for
    // its packages (503 on the live run). CLAUDE.md 8.
    const { handler, askedFor } = handlerWith();
    await handler.seat('walk-1', 660, 'maya');
    expect(askedFor).toEqual(['marina-walk']);
  });

  it('hands the desk the package, so confirm charges its price', async () => {
    const { handler } = handlerWith();
    const out = await handler.seat('walk-1', 660, 'maya');
    expect(out.serviceIds).toEqual(['colour-and-finish']);
  });

  it('holds a station per part, not the last one for the whole visit', async () => {
    const { handler, placed } = handlerWith();
    await handler.seat('walk-1', 660, 'maya');

    const demand: readonly ResourceDemand[] = placed[0]!.resourceDemand;
    const types = demand.map((d) => d.resourceType);
    expect(types).toContain('color');
    expect(types).toContain('styling');
    // No styling chair for the full 170 minutes.
    expect(
      demand.some(
        (d) => d.resourceType === 'styling' && d.endMin - d.startMin === 170,
      ),
    ).toBe(false);
    // The colour comes first, from the seat's start.
    expect(demand.find((d) => d.resourceType === 'color')?.startMin).toBe(660);
  });

  it('still seats an entry written before, holding the parts', async () => {
    const { handler } = handlerWith(['full-colour', 'blow-dry']);
    const out = await handler.seat('walk-1', 660, 'maya');
    expect(out.serviceIds).toEqual(['full-colour', 'blow-dry']);
  });

  it('refuses an entry whose service the branch no longer sells', async () => {
    const { handler } = handlerWith(['retired-service']);
    await expect(handler.seat('walk-1', 660, 'maya')).rejects.toThrow(
      /no longer sells: retired-service/,
    );
  });
});
