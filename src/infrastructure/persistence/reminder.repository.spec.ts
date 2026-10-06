import { describe, it, expect, vi } from 'vitest';
import { ReminderRepository } from './reminder.repository';
import { rungSpec } from '@domain/booking/reminders';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-10T06:00:00Z');

interface Row {
  id: string;
  code: string;
  start_at: Date;
  customer_id: string;
  payment_status: string;
  reminded_24h_at: Date | null;
  reminded_3h_at: Date | null;
  nudged_15m_at: Date | null;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'b1',
  code: 'GS-1050',
  start_at: new Date(NOW + 20 * HOUR),
  customer_id: 'c1',
  payment_status: 'deposit_paid',
  reminded_24h_at: new Date(NOW),
  reminded_3h_at: null,
  nudged_15m_at: null,
  ...over,
});

function build(claimed: Row[] = []) {
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue(claimed),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    eventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { repo: new ReminderRepository(prisma as never), tx, prisma };
}

const sqlOf = (tx: ReturnType<typeof build>['tx']): string =>
  tx.$queryRawUnsafe.mock.calls[0]![0] as string;

describe('the claim takes one rung, in ladder order', () => {
  it('24h claims with no precondition on the other rungs', async () => {
    const { repo, tx } = build();
    await repo.runRung(rungSpec('confirm_24h'), NOW);
    expect(sqlOf(tx)).toContain('reminded_24h_at IS NULL');
    expect(sqlOf(tx)).not.toContain('IS NOT NULL');
  });

  it('3h claims only after the 24h rung is stamped', async () => {
    const { repo, tx } = build();
    await repo.runRung(rungSpec('day_of_3h'), NOW);
    expect(sqlOf(tx)).toContain('reminded_3h_at IS NULL');
    expect(sqlOf(tx)).toContain('AND reminded_24h_at IS NOT NULL');
  });

  it('15m claims only after both earlier rungs are stamped', async () => {
    const { repo, tx } = build();
    await repo.runRung(rungSpec('running_late_15m'), NOW);
    expect(sqlOf(tx)).toContain('AND reminded_24h_at IS NOT NULL');
    expect(sqlOf(tx)).toContain('AND reminded_3h_at IS NOT NULL');
  });

  it('claims with SKIP LOCKED, live statuses only, up to the lead time', async () => {
    const { repo, tx } = build();
    await repo.runRung(rungSpec('day_of_3h'), NOW);
    const [sql, statuses, horizon] = tx.$queryRawUnsafe.mock.calls[0] as [
      string,
      string[],
      Date,
    ];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(statuses).toEqual(['confirmed', 'pending_payment']);
    expect(horizon).toEqual(new Date(NOW + 3 * HOUR));
  });

  it('runs the rungs furthest out first', async () => {
    const { repo, tx } = build();
    await repo.runLadder(NOW);
    const columns = tx.$queryRawUnsafe.mock.calls.map(
      ([sql]) => /SET (\w+) = now\(\)/.exec(sql as string)![1],
    );
    expect(columns).toEqual([
      'reminded_24h_at',
      'reminded_3h_at',
      'nudged_15m_at',
    ]);
  });
});

describe('what a claim writes', () => {
  it('a 24h send writes reminder.confirm_24h with the start it was claimed for', async () => {
    const { repo, tx } = build([row({ reminded_24h_at: new Date(NOW) })]);
    const got = await repo.runRung(rungSpec('confirm_24h'), NOW);

    expect(got).toEqual({
      rung: 'confirm_24h',
      sent: 1,
      skipped: 0,
      released: 0,
    });
    const [{ data }] = tx.eventOutbox.create.mock.calls[0] as [
      { data: unknown },
    ];
    expect(data).toMatchObject({
      aggregateType: 'booking',
      aggregateId: 'b1',
      eventType: 'reminder.confirm_24h',
      payload: {
        code: 'GS-1050',
        startAt: new Date(NOW + 20 * HOUR).toISOString(),
        customerId: 'c1',
        paymentPending: false,
      },
    });
  });

  it('a booking made two hours out skips its 24h rung without an event', async () => {
    const { repo, tx } = build([
      row({ start_at: new Date(NOW + 2 * HOUR), reminded_24h_at: new Date() }),
    ]);
    const got = await repo.runRung(rungSpec('confirm_24h'), NOW);
    expect(got.skipped).toBe(1);
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('a claim that is not its rung is released, not stamped as handled', async () => {
    // A row the claim should never have returned: 3h claimed while 24h open.
    const { repo, tx } = build([
      row({
        start_at: new Date(NOW + 2 * HOUR),
        reminded_24h_at: null,
        reminded_3h_at: new Date(NOW),
      }),
    ]);
    const got = await repo.runRung(rungSpec('day_of_3h'), NOW);

    expect(got).toEqual({
      rung: 'day_of_3h',
      sent: 0,
      skipped: 0,
      released: 1,
    });
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE booking SET reminded_3h_at = NULL WHERE id = ANY($1::uuid[])',
      ['b1'],
    );
  });
});
