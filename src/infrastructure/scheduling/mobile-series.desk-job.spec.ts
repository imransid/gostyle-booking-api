import { describe, expect, it, vi } from 'vitest';
import { SeriesMaterialiser } from './series-materialiser.service';
import { SeriesRepository } from '../persistence/series.repository';
import {
  MOBILE_NEVER_TOPPED_UP,
  MobileSeriesRepository,
} from '../persistence/mobile-series.repository';
import { TenantContext } from '../tenancy/tenant-context';
import type { PrismaService } from '../persistence/prisma.service';
import type { MaterialiseSeriesHandler } from '@application/commands/materialise-series.handler';

/**
 * THE DESK NIGHTLY JOB NEVER TOUCHES A MOBILE ROUTINE (plan E.6, step 2).
 *
 * The job (SeriesMaterialiser) asks SeriesRepository.dueForTopUp which
 * series to work on, and runs MaterialiseSeriesHandler on each: that writes
 * materialised_through and books planned occurrences through the desk path.
 * A mobile routine must never be one of them, and the desk code must not
 * change to make that true.
 *
 * So this runs THE REAL JOB and THE REAL QUERY CODE (neither is faked) over
 * a small in-memory booking_series table, holding:
 *   - a mobile routine, exactly as MobileSeriesRepository.create writes it
 *     (captured from a real call, not typed out here);
 *   - a desk series that is due, as the control: it proves the table
 *     really filters, so "nothing picked" cannot be a fake that picks
 *     nothing.
 *
 * THE TABLE READS THE QUERY STRICTLY. It understands the filters the desk
 * query uses today and throws on anything else, so the day the desk query
 * changes shape, this spec fails and someone reads the new query, instead
 * of it passing by accident. The same query is proven against Postgres in
 * prisma/proof-mobile-series-created.sql.
 */

const DESK = 'dddddddd-0000-4ddd-8ddd-dddddddddddd';
const MOBILE = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';

interface Row {
  readonly id: string;
  readonly status: string;
  readonly materialisedThrough: Date | null;
}

/** The mobile row, as the mobile create writes it. */
async function mobileRowAsWritten(): Promise<Row> {
  let data: Record<string, unknown> = {};
  const tx = {
    bookingSeries: {
      create: (a: { data: Record<string, unknown> }) => {
        data = a.data;
        return Promise.resolve({ id: MOBILE });
      },
    },
    seriesOccurrence: { createMany: () => Promise.resolve({ count: 1 }) },
    booking: { updateMany: () => Promise.resolve({ count: 1 }) },
    eventOutbox: { create: () => Promise.resolve({}) },
  };
  const prisma = {
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  await new MobileSeriesRepository(prisma, new TenantContext()).create({
    branchId: 'marina-walk',
    customerId: '11111111-1111-4111-8111-111111111111',
    frequency: 'weekly',
    serviceIds: ['haircut-finish'],
    stylistId: 'maya',
    startMin: 990,
    paymentPlan: 'pay_at_salon',
    baselinePriceFils: 16_000,
    sessions: [
      {
        index: 0,
        day: '2026-10-06',
        startMin: 990,
        movedFromDayOfMonth: null,
        bookingId: 'b-0',
      },
      {
        index: 1,
        day: '2026-10-13',
        startMin: 990,
        movedFromDayOfMonth: null,
        bookingId: 'b-1',
      },
    ],
  });
  return {
    id: MOBILE,
    // The column default: a new routine is active.
    status: (data.status as string | undefined) ?? 'active',
    materialisedThrough: data.materialisedThrough as Date,
  };
}

/** One condition of the desk query's `where`, read strictly. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'status') {
      if (row.status !== cond) return false;
    } else if (key === 'OR') {
      const any = (cond as Record<string, unknown>[]).some((c) =>
        matches(row, c),
      );
      if (!any) return false;
    } else if (key === 'materialisedThrough') {
      if (cond === null) {
        if (row.materialisedThrough !== null) return false;
        continue;
      }
      const ops = Object.keys(cond as object);
      if (ops.length !== 1 || ops[0] !== 'lt') {
        throw new Error(
          `the desk query uses materialisedThrough ${ops.join()}`,
        );
      }
      const lt = (cond as { lt: Date }).lt;
      if (row.materialisedThrough === null || !(row.materialisedThrough < lt)) {
        return false;
      }
    } else {
      throw new Error(
        `The desk nightly query grew a filter this spec does not read: "${key}". ` +
          'Read the new query and extend this spec.',
      );
    }
  }
  return true;
}

function deskJob(rows: readonly Row[]) {
  const writes: string[] = [];
  const write = (name: string) => () => {
    writes.push(name);
    return Promise.resolve({});
  };
  const prisma = {
    bookingSeries: {
      findMany: (args: Record<string, unknown>) => {
        const known = ['where', 'orderBy', 'take', 'select'];
        const extra = Object.keys(args).filter((k) => !known.includes(k));
        if (extra.length > 0)
          throw new Error(`unread query keys: ${extra.join()}`);
        const where = args.where as Record<string, unknown>;
        return Promise.resolve(
          rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id })),
        );
      },
      update: write('bookingSeries.update'),
      updateMany: write('bookingSeries.updateMany'),
    },
    seriesOccurrence: {
      createMany: write('seriesOccurrence.createMany'),
      updateMany: write('seriesOccurrence.updateMany'),
    },
    $transaction: write('$transaction'),
  } as unknown as PrismaService;

  const ran: string[] = [];
  const handler = {
    run: vi.fn((id: string) => {
      ran.push(id);
      return Promise.resolve({ materialised: 0, needsAttention: 0 });
    }),
  } as unknown as MaterialiseSeriesHandler;

  const job = new SeriesMaterialiser(
    new SeriesRepository(prisma, new TenantContext()),
    handler,
  );
  return { job, ran, writes };
}

/** A desk series whose calendar fell behind: the nightly job's bread and butter. */
const deskDue: Row = {
  id: DESK,
  status: 'active',
  materialisedThrough: new Date('2026-09-01T00:00:00Z'),
};

describe('the desk nightly job and a mobile routine', () => {
  it('the mobile create writes the "never" date', async () => {
    const row = await mobileRowAsWritten();
    expect(MOBILE_NEVER_TOPPED_UP).toBe('9999-12-31');
    expect(row.materialisedThrough).toEqual(new Date('9999-12-31T00:00:00Z'));
    expect(row.status).toBe('active');
  });

  it.each([
    ['the day it was made', '2026-10-01'],
    ['the day of its first session', '2026-10-06'],
    ['the day of its last session', '2026-10-13'],
    ['the day after its last session', '2026-10-14'],
    ['a year on', '2027-10-14'],
    ['fifty years on', '2076-10-14'],
    ['the last day there is', '9999-12-31'],
  ])('never picks it: %s (%s)', async (_, today) => {
    const mobile = await mobileRowAsWritten();
    const { job, ran, writes } = deskJob([mobile, deskDue]);

    const out = await job.run(today);

    expect(ran).not.toContain(MOBILE);
    // The control: the same run DID pick the desk series that was due.
    expect(ran).toEqual([DESK]);
    expect(out.series).toBe(1);
    // The job itself only reads; everything it writes goes through the
    // handler, which never saw the routine.
    expect(writes).toEqual([]);
  });

  it('a paused or ended mobile routine is not picked either', async () => {
    const mobile = await mobileRowAsWritten();
    for (const status of ['paused', 'ended', 'completed']) {
      const { job, ran } = deskJob([{ ...mobile, status }]);
      await job.run('2030-01-01');
      expect(ran).toEqual([]);
    }
  });

  it('the table is strict: a filter it does not read fails the spec', () => {
    expect(() => matches(deskDue, { status: 'active', source: null })).toThrow(
      'grew a filter',
    );
  });
});
