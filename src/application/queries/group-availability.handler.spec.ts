import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import {
  GroupAvailabilityHandler,
  type GroupAvailabilityQuery,
} from './group-availability.handler';
import { GroupHoldRepository } from '@infrastructure/persistence/group-hold.repository';
import { FixtureBookingContext } from '@infrastructure/fixtures/fixture-booking-context';
import { toUuid } from '@infrastructure/persistence/hold.repository';
import type { PrismaService } from '@infrastructure/persistence/prisma.service';
import type { TenantContext } from '@infrastructure/tenancy/tenant-context';
import type { DayContext } from '@application/ports/booking-context.port';
import {
  MAX_PARTY_STARTS,
  halfHourStarts,
} from '@domain/availability/party-starts';

/**
 * GROUP AVAILABILITY, END TO END BELOW THE HTTP LAYER.
 *
 * The real handler, the real repository, the real planner and the fixture
 * catalogue and roster. Only Prisma is faked, and only as far as the two
 * reads the repository makes: who is busy, and which chairs are taken.
 *
 * The first block PINS the single-start answer. Its snapshots were written
 * against the handler as it stood before `targetMins` existed, and are
 * compared as JSON strings so a reordered key fails as loudly as a changed
 * value: the wire gets JSON.stringify, and so does this.
 */

// ------------------------------------------------------------ the diary

interface StaffRow {
  staffId: string;
  startMinute: number;
  durationMin: number;
}
interface ChairRow {
  resourceType: string;
  startMinute: number;
  durationMin: number;
}

const busy = (staff: string, from: number, to: number): StaffRow => ({
  staffId: toUuid(staff),
  startMinute: from,
  durationMin: to - from,
});
const taken = (type: string, from: number, to: number): ChairRow => ({
  resourceType: type,
  startMinute: from,
  durationMin: to - from,
});

/**
 * A day with enough in it that the answer changes across it: professionals
 * busy at different times, a styling rush that leaves one chair, and an
 * hour when every nail station is taken.
 */
const DIARY = {
  staff: [
    busy('anya', 600, 690),
    busy('anya', 900, 1080),
    busy('maya', 660, 780),
    busy('maya', 960, 1020),
    busy('reem', 720, 840),
    busy('lina', 780, 900),
    busy('tara', 1080, 1200),
  ],
  chairs: [
    taken('styling', 720, 780),
    taken('styling', 720, 780),
    taken('nail', 900, 960),
    taken('nail', 900, 960),
    taken('nail', 900, 960),
  ],
};

// ------------------------------------------------------------ the fakes

/** Prisma, as far as GroupHoldRepository reads it. Counts what it is asked. */
function fakePrisma() {
  const calls = { transactions: 0, staffReads: 0, chairReads: 0 };
  const tx = {
    staffReservation: {
      findMany: () => {
        calls.staffReads++;
        return Promise.resolve(DIARY.staff.map((r) => ({ ...r })));
      },
    },
    resourceReservation: {
      findMany: () => {
        calls.chairReads++;
        return Promise.resolve(DIARY.chairs.map((r) => ({ ...r })));
      },
    },
  };
  const prisma = {
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      calls.transactions++;
      return fn(tx);
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

/** The fixture context, counting its loads, optionally closed. */
class CountingContext extends FixtureBookingContext {
  days = 0;
  serviceLoads = 0;

  constructor(private readonly closure?: string) {
    super();
  }

  override async loadDay(branchId: string, day: string): Promise<DayContext> {
    this.days++;
    const loaded = await super.loadDay(branchId, day);
    return this.closure === undefined
      ? loaded
      : { ...loaded, closureReason: this.closure };
  }

  override loadServices(branchId: string, ids: readonly string[]) {
    this.serviceLoads++;
    return super.loadServices(branchId, ids);
  }
}

function rig(closure?: string) {
  const { prisma, calls } = fakePrisma();
  const context = new CountingContext(closure);
  const repo = new GroupHoldRepository(prisma, {} as TenantContext);
  return {
    handler: new GroupAvailabilityHandler(repo, context),
    context,
    calls,
  };
}

// ------------------------------------------------------------ the parties

type Party = Omit<GroupAvailabilityQuery, 'targetMin'>;

const base = { branchId: 'marina-walk', tradingDay: '2026-10-11' } as const;

const who = (
  label: string,
  serviceIds: string[],
  preferredStaffId: string | null = null,
) => ({
  label,
  serviceIds,
  preferredStaffId,
});

/** Each chosen to reach a different part of the planner. */
const PARTIES: Readonly<Record<string, Party>> = {
  pair: {
    ...base,
    mode: 'arrive_together',
    participants: [who('A', ['haircut-finish']), who('B', ['gel-manicure'])],
  },
  'trio with a preference': {
    ...base,
    mode: 'arrive_together',
    participants: [
      who('A', ['hair-colour'], 'maya'),
      who('B', ['blow-dry']),
      who('C', ['brow-lamination']),
    ],
  },
  'finish together with slack': {
    ...base,
    mode: 'finish_together',
    finishWindowMin: 15,
    maxStaggerMin: 120,
    participants: [
      who('A', ['balayage']),
      who('B', ['blow-dry']),
      who('C', ['fringe-trim']),
    ],
  },
  'more people than styling chairs': {
    ...base,
    mode: 'arrive_together',
    participants: [
      who('A', ['haircut-finish']),
      who('B', ['haircut-finish']),
      who('C', ['blow-dry']),
      who('D', ['blow-dry']),
    ],
  },
  'three manicures, one manicurist': {
    ...base,
    mode: 'arrive_together',
    participants: [
      who('A', ['gel-manicure']),
      who('B', ['gel-manicure']),
      who('C', ['gel-manicure']),
    ],
  },
};

/** Every half hour of the engine's day, plus the last minute and two odd ones. */
const STARTS: readonly number[] = [
  ...Array.from({ length: 24 }, (_, i) => 600 + i * 30),
  1319,
  605,
  1000,
];

/** A refusal as the wire would see it: which, which status, what it said. */
function refusal(e: unknown): string {
  if (!(e instanceof HttpException)) throw e;
  return JSON.stringify({
    name: e.constructor.name,
    status: e.getStatus(),
    response: e.getResponse(),
  });
}

// ------------------------------------------------------------ the pins

describe('one start: the answer as it was before targetMins existed', () => {
  for (const [name, party] of Object.entries(PARTIES)) {
    it(`${name}, at every start`, async () => {
      const { handler } = rig();
      const answers: string[] = [];
      for (const targetMin of STARTS) {
        answers.push(
          JSON.stringify(await handler.execute({ ...party, targetMin })),
        );
      }
      expect(answers).toMatchSnapshot();
    });
  }

  it('reaches both answers: some starts fit and some do not', async () => {
    const { handler } = rig();
    const kinds = new Set<boolean>();
    for (const party of Object.values(PARTIES)) {
      for (const targetMin of STARTS) {
        kinds.add((await handler.execute({ ...party, targetMin })).feasible);
      }
    }
    // Pins that the snapshots above are worth having: a fixture where
    // everything fits, or nothing does, would pin one branch only.
    expect([...kinds].sort()).toEqual([false, true]);
  });

  it('a closed day is refused the same way', async () => {
    const { handler } = rig('Closed for Eid.');
    const answer = await handler
      .execute({ ...PARTIES.pair!, targetMin: 600 })
      .then(() => 'accepted', refusal);
    expect(answer).toMatchSnapshot();
  });

  it('an unknown service is refused the same way', async () => {
    const { handler } = rig();
    const answer = await handler
      .execute({
        ...PARTIES.pair!,
        participants: [
          who('A', ['haircut-finish']),
          who('B', ['no-such-thing']),
        ],
        targetMin: 600,
      })
      .then(() => 'accepted', refusal);
    expect(answer).toMatchSnapshot();
  });

  it('loads the day and the services once per start asked', async () => {
    const { handler, context, calls } = rig();
    await handler.execute({ ...PARTIES.pair!, targetMin: 600 });
    expect({
      days: context.days,
      serviceLoads: context.serviceLoads,
      ...calls,
    }).toEqual({
      days: 1,
      serviceLoads: 2,
      transactions: 1,
      staffReads: 1,
      chairReads: 1,
    });
  });
});

// ------------------------------------------------------------ many starts

/** The day view's own list, and an awkward one: unsorted, with a repeat. */
const LISTS: Readonly<Record<string, readonly number[]>> = {
  'every half hour': halfHourStarts(),
  'unsorted, with a repeat': [1319, 605, 1000, 1000, 600, 900],
};

/** What asking one start at a time answers, as the wire would carry it. */
async function oneAtATime(
  party: Party,
  starts: readonly number[],
): Promise<string[]> {
  const { handler } = rig();
  const out: string[] = [];
  for (const targetMin of starts) {
    out.push(JSON.stringify(await handler.execute({ ...party, targetMin })));
  }
  return out;
}

describe('many starts: the same answers as asking one at a time', () => {
  for (const [name, party] of Object.entries(PARTIES)) {
    for (const [listName, targetMins] of Object.entries(LISTS)) {
      it(`${name}, ${listName}`, async () => {
        const { handler } = rig();
        const many = await handler.executeMany({ ...party, targetMins });

        expect(many.starts).toHaveLength(targetMins.length);
        // Entry by entry, as JSON: the same keys, in the same order, with
        // the same values, as the single call for that start.
        expect(many.starts.map((s) => JSON.stringify(s))).toEqual(
          await oneAtATime(party, targetMins),
        );
      });
    }
  }

  it('answers in the order asked', async () => {
    const { handler } = rig();
    const targetMins = LISTS['unsorted, with a repeat']!;
    const many = await handler.executeMany({ ...PARTIES.pair!, targetMins });
    expect(many.starts.map((s) => s.targetMin)).toEqual(targetMins);
  });

  it('is only the key it adds: { starts }', async () => {
    const { handler } = rig();
    const many = await handler.executeMany({
      ...PARTIES.pair!,
      targetMins: [600],
    });
    expect(Object.keys(many)).toEqual(['starts']);
  });
});

describe('many starts: loaded once, not once per start', () => {
  it('reads the day, the services and the diary once for 24 starts', async () => {
    const { handler, context, calls } = rig();
    await handler.executeMany({
      ...PARTIES['trio with a preference']!,
      targetMins: halfHourStarts(),
    });
    expect({
      days: context.days,
      serviceLoads: context.serviceLoads,
      ...calls,
    }).toEqual({
      days: 1,
      serviceLoads: 3, // one per participant
      transactions: 1,
      staffReads: 1,
      chairReads: 1,
    });
  });

  it('where asking one at a time reads them 24 times', async () => {
    const { handler, context, calls } = rig();
    for (const targetMin of halfHourStarts()) {
      await handler.execute({
        ...PARTIES['trio with a preference']!,
        targetMin,
      });
    }
    expect({
      days: context.days,
      serviceLoads: context.serviceLoads,
      ...calls,
    }).toEqual({
      days: 24,
      serviceLoads: 72,
      transactions: 24,
      staffReads: 24,
      chairReads: 24,
    });
  });
});

describe('many starts: refused exactly as one start is', () => {
  /** The same party asked both ways; the refusals must be identical. */
  async function bothWays(
    party: Party,
    closure?: string,
  ): Promise<{ one: string; many: string }> {
    const one = await rig(closure)
      .handler.execute({ ...party, targetMin: 600 })
      .then(() => 'accepted', refusal);
    const many = await rig(closure)
      .handler.executeMany({ ...party, targetMins: [600, 630] })
      .then(() => 'accepted', refusal);
    return { one, many };
  }

  it('a closed day', async () => {
    const { one, many } = await bothWays(PARTIES.pair!, 'Closed for Eid.');
    expect(one).toContain('"status":409');
    expect(many).toBe(one);
  });

  it('an unknown service', async () => {
    const { one, many } = await bothWays({
      ...PARTIES.pair!,
      participants: [who('A', ['haircut-finish']), who('B', ['no-such-thing'])],
    });
    expect(one).toContain('"status":422');
    expect(many).toBe(one);
  });

  it('a party of one', async () => {
    const { one, many } = await bothWays({
      ...PARTIES.pair!,
      participants: [who('A', ['haircut-finish'])],
    });
    expect(one).toContain('at least two');
    expect(many).toBe(one);
  });

  it('a party of nine', async () => {
    const { one, many } = await bothWays({
      ...PARTIES.pair!,
      participants: Array.from({ length: 9 }, (_, i) =>
        who(`P${i}`, ['blow-dry']),
      ),
    });
    expect(one).toContain('online cap of 8');
    expect(many).toBe(one);
  });
});

describe('many starts: the cap, below the HTTP layer too', () => {
  const ask = (targetMins: number[]) =>
    rig()
      .handler.executeMany({ ...PARTIES.pair!, targetMins })
      .then((v) => `answered ${v.starts.length}`, refusal);

  it(`answers ${MAX_PARTY_STARTS}`, async () => {
    expect(await ask(halfHourStarts())).toBe(`answered ${MAX_PARTY_STARTS}`);
  });

  it(`refuses ${MAX_PARTY_STARTS + 1}, before loading anything`, async () => {
    const { handler, context, calls } = rig();
    const answer = await handler
      .executeMany({
        ...PARTIES.pair!,
        targetMins: [...halfHourStarts(), 1319],
      })
      .then(() => 'accepted', refusal);
    expect(answer).toContain('"status":422');
    expect(answer).toContain(`between 1 and ${MAX_PARTY_STARTS}`);
    expect(context.days + calls.transactions).toBe(0);
  });

  it('refuses none', async () => {
    expect(await ask([])).toContain('"status":422');
  });
});
