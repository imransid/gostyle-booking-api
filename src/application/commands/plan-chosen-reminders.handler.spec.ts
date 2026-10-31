import { describe, it, expect, vi } from 'vitest';
import { PlanChosenRemindersHandler } from './plan-chosen-reminders.handler';
import type { ChosenCandidate } from '@infrastructure/persistence/reminder.repository';
import type { ReminderLeadsAnswer } from '@application/ports/reminder-leads.port';
import type { ReminderChoice } from '@domain/booking/chosen-reminder';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-02T06:30:00Z');

const candidate = (over: Partial<ChosenCandidate> = {}): ChosenCandidate => ({
  id: 'b1',
  code: 'GS-1483',
  customerId: 'c1',
  startAtMs: NOW + HOUR,
  touchedAtMs: NOW - 3 * 24 * HOUR,
  ...over,
});

function build(candidates: ChosenCandidate[], answer: ReminderLeadsAnswer) {
  const reminders = {
    chosenCandidates: vi.fn((_now: number) => Promise.resolve(candidates)),
    claimChosen: vi.fn((_c: ChosenCandidate, _v: unknown) =>
      Promise.resolve('sent' as 'sent' | 'skipped' | 'lost'),
    ),
  };
  const leads = {
    leads: vi.fn((_ids: readonly string[]) => Promise.resolve(answer)),
  };
  const handler = new PlanChosenRemindersHandler(reminders as never, leads);
  return { handler, reminders, leads };
}

const answered = (
  entries: [string, ReminderChoice][],
): ReminderLeadsAnswer => ({
  kind: 'answered',
  leads: new Map(entries),
});

describe('PlanChosenRemindersHandler', () => {
  it('nothing outstanding: customer-api is not asked', async () => {
    const { handler, leads } = build([], answered([]));
    expect((await handler.run(NOW)).candidates).toBe(0);
    expect(leads.leads).not.toHaveBeenCalled();
  });

  it('asks once for every customer, and claims what is due', async () => {
    const due = candidate({ id: 'b1', customerId: 'c1' });
    const notYet = candidate({
      id: 'b2',
      customerId: 'c2',
      startAtMs: NOW + 5 * HOUR,
    });
    const { handler, reminders, leads } = build(
      [due, notYet],
      answered([
        ['c1', { enabled: true, leadMinutes: 60 }],
        ['c2', { enabled: true, leadMinutes: 60 }],
      ]),
    );

    const report = await handler.run(NOW);

    expect(leads.leads).toHaveBeenCalledOnce();
    expect(leads.leads.mock.calls[0]![0]).toEqual(['c1', 'c2']);
    expect(reminders.claimChosen).toHaveBeenCalledOnce();
    expect(reminders.claimChosen.mock.calls[0]![1]).toEqual({
      kind: 'send',
      leadMinutes: 60,
      late: false,
    });
    expect(report).toMatchObject({ sent: 1, waiting: 1 });
  });

  it('no answer from customer-api: nothing is decided, nothing stamped', async () => {
    const { handler, reminders } = build([candidate()], {
      kind: 'unavailable',
      error: 'customer-api UNAVAILABLE',
    });
    const report = await handler.run(NOW);
    expect(report.unavailable).toBe(true);
    expect(reminders.claimChosen).not.toHaveBeenCalled();
  });

  it('a customer customer-api does not know, or with reminders off, waits', async () => {
    const { handler, reminders } = build(
      [
        candidate({ customerId: 'gone' }),
        candidate({ id: 'b2', customerId: 'off' }),
      ],
      answered([['off', { enabled: false, leadMinutes: 60 }]]),
    );
    const report = await handler.run(NOW);
    expect(report.waiting).toBe(2);
    expect(reminders.claimChosen).not.toHaveBeenCalled();
  });

  it('counts what the claim answered', async () => {
    const { handler, reminders } = build(
      [candidate(), candidate({ id: 'b2', touchedAtMs: NOW })],
      answered([['c1', { enabled: true, leadMinutes: 60 }]]),
    );
    reminders.claimChosen
      .mockResolvedValueOnce('lost')
      .mockResolvedValueOnce('skipped');
    const report = await handler.run(NOW);
    expect(report).toMatchObject({ lost: 1, skipped: 1, sent: 0 });
    // The second was touched after its time: passed over, as booked_late.
    expect(reminders.claimChosen.mock.calls[1]![1]).toMatchObject({
      kind: 'skip',
      reason: 'booked_late',
    });
  });
});
