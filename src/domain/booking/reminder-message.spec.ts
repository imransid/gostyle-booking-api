import { describe, it, expect } from 'vitest';
import {
  clockTime,
  dayPhrase,
  durationLabel,
  emailCopy,
  longDate,
  pushCopy,
  type ReminderFacts,
} from './reminder-message';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DHAKA = 360;
const DUBAI = 240;

// October 11, 10:00 in Dhaka.
const START = Date.parse('2026-10-11T04:00:00Z');

const facts = (over: Partial<ReminderFacts> = {}): ReminderFacts => ({
  rung: 'confirm_24h',
  startAtMs: START,
  nowMs: START - 24 * HOUR,
  offsetMin: DHAKA,
  code: 'GS-1050',
  services: ['Full colour'],
  durationMin: 105,
  paymentPending: false,
  firstName: 'Sara',
  ...over,
});

describe('every time shown is branch time', () => {
  it('10:00 in Dhaka reads 10:00 AM, whatever the server clock', () => {
    expect(clockTime(START, DHAKA)).toBe('10:00 AM');
  });

  it('the same instant in a Dubai branch reads 8:00 AM', () => {
    expect(clockTime(START, DUBAI)).toBe('8:00 AM');
  });

  it.each([
    ['2026-10-11T18:00:00Z', '12:00 AM'],
    ['2026-10-11T06:30:00Z', '12:30 PM'],
    ['2026-10-11T13:05:00Z', '7:05 PM'],
  ])('%s reads %s in Dhaka', (iso, text) => {
    expect(clockTime(Date.parse(iso), DHAKA)).toBe(text);
  });

  it('the date is the branch date: 22:30 UTC on the 10th is the 11th in Dhaka', () => {
    expect(longDate(Date.parse('2026-10-10T22:30:00Z'), DHAKA)).toBe(
      'Sunday, 11 October 2026',
    );
    expect(longDate(Date.parse('2026-10-10T19:30:00Z'), DUBAI)).toBe(
      'Saturday, 10 October 2026',
    );
  });
});

describe("the visit's day, from now", () => {
  it('October 10 at 10:00 for October 11 at 10:00 is tomorrow', () => {
    expect(dayPhrase(START, START - 24 * HOUR, DHAKA)).toBe('tomorrow');
  });

  it('three hours before is today', () => {
    expect(dayPhrase(START, START - 3 * HOUR, DHAKA)).toBe('today');
  });

  it('further out is named', () => {
    expect(dayPhrase(START, START - 5 * 24 * HOUR, DHAKA)).toBe(
      'on Sunday 11 October',
    );
  });

  it('is counted on the branch calendar, not UTC', () => {
    // 00:30 on the 11th in Dhaka is still the 10th in UTC. The visit at
    // 10:00 on the 11th is "today" for the customer, not "tomorrow".
    const justAfterMidnight = Date.parse('2026-10-10T18:30:00Z');
    expect(dayPhrase(START, justAfterMidnight, DHAKA)).toBe('today');
  });
});

describe('durationLabel', () => {
  it.each([
    [45, '45 min'],
    [60, '1 h'],
    [105, '1 h 45 min'],
  ])('%i -> %s', (min, text) => {
    expect(durationLabel(min)).toBe(text);
  });
});

describe('push', () => {
  it('24h: the day, the time, the services, the code', () => {
    expect(pushCopy(facts())).toEqual({
      title: 'Your appointment is tomorrow',
      body: 'Full colour at 10:00 AM. Booking GS-1050.',
    });
  });

  it('24h with money pending prompts for it', () => {
    expect(pushCopy(facts({ paymentPending: true })).body).toBe(
      'Full colour at 10:00 AM. Booking GS-1050. A payment is still due for this booking.',
    );
  });

  it('3h: see you today at the time', () => {
    expect(
      pushCopy(facts({ rung: 'day_of_3h', nowMs: START - 3 * HOUR })),
    ).toEqual({
      title: 'See you today at 10:00 AM',
      body: 'Full colour. Booking GS-1050.',
    });
  });

  it('15m: running late?', () => {
    expect(
      pushCopy(facts({ rung: 'running_late_15m', nowMs: START - 15 * MIN })),
    ).toEqual({
      title: 'Your appointment starts at 10:00 AM',
      body: 'Running late? Let the salon know. Booking GS-1050.',
    });
  });

  it('with no service on record, says "your visit" rather than inventing one', () => {
    expect(pushCopy(facts({ services: [] })).body).toBe(
      'Your visit at 10:00 AM. Booking GS-1050.',
    );
  });
});

describe('email', () => {
  it('the subject the spec asks for: "Reminder: Your GoStyle appointment is tomorrow"', () => {
    expect(emailCopy(facts()).subject).toBe(
      'Reminder: Your GoStyle appointment is tomorrow',
    );
  });

  it('the 3h subject names the time', () => {
    expect(
      emailCopy(facts({ rung: 'day_of_3h', nowMs: START - 3 * HOUR })).subject,
    ).toBe('Reminder: Your GoStyle appointment is today at 10:00 AM');
  });

  it('greets by first name, date, time, services, duration and code', () => {
    const copy = emailCopy(facts({ services: ['Full colour', 'Blow-dry'] }));
    expect(copy.greeting).toBe('Hi Sara,');
    expect(copy.details).toEqual([
      { label: 'Date', value: 'Sunday, 11 October 2026' },
      { label: 'Time', value: '10:00 AM' },
      { label: 'Services', value: 'Full colour, Blow-dry' },
      { label: 'Duration', value: '1 h 45 min' },
      { label: 'Booking code', value: 'GS-1050' },
    ]);
  });

  it('leaves out what it does not know, rather than guessing', () => {
    const copy = emailCopy(
      facts({ firstName: null, services: [], durationMin: 0 }),
    );
    expect(copy.greeting).toBe('Hi,');
    expect(copy.details.map((d) => d.label)).toEqual([
      'Date',
      'Time',
      'Booking code',
    ]);
  });

  it('the inbox preview leads with the brand, not the code', () => {
    const copy = emailCopy(facts());
    expect(copy.preheader).toBe(
      'GoStyle · Sunday, 11 October 2026 at 10:00 AM',
    );
    expect(copy.preheader).not.toContain('GS-1050');
  });

  it('a pending payment is a note', () => {
    expect(emailCopy(facts({ paymentPending: true })).notes).toEqual([
      'A payment is still due for this booking.',
    ]);
  });
});
