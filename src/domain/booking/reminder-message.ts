/**
 * What a reminder says, per rung, for push and for email.
 *
 * ONLY WHAT THIS SERVICE KNOWS. The booking code, the start, the services
 * and duration from the booking_item snapshot, whether money is still due,
 * and the customer's name from customer-api. There is no branch name or
 * address anywhere in the booking database, so the copy never pretends to
 * have one.
 *
 * EVERY TIME IS BRANCH TIME. The visit happens at the salon, so "10:00 AM"
 * is the salon's 10:00 whatever the phone's clock says. The offset comes in
 * as a number (hold.repository.ts `branchUtcOffsetMin`, from
 * BRANCH_TIMEZONE); the formatting is done by hand from it, because Intl's
 * output changes between ICU versions (a narrow no-break space crept in
 * before "AM") and copy a customer reads should not.
 *
 * Pure: no clock, no environment, no I/O.
 */
import type { Rung } from './reminders';

export const BRAND = 'GoStyle';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface ReminderFacts {
  readonly rung: Rung;
  readonly startAtMs: number;
  readonly nowMs: number;
  /** The branch's offset, minutes east of UTC. */
  readonly offsetMin: number;
  readonly code: string;
  /** booking_item.service_name, in booking order. May be empty. */
  readonly services: readonly string[];
  readonly durationMin: number;
  readonly paymentPending: boolean;
  /** From customer-api. Null when it holds no name. */
  readonly firstName: string | null;
}

export interface PushCopy {
  readonly title: string;
  readonly body: string;
}

export interface EmailCopy {
  readonly subject: string;
  /** The inbox preview line. Leads with the brand, never the code. */
  readonly preheader: string;
  readonly heading: string;
  readonly greeting: string;
  readonly lines: readonly string[];
  readonly details: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly notes: readonly string[];
}

/** The instant, moved onto the branch's wall clock; read it with getUTC*. */
function wallClock(ms: number, offsetMin: number): Date {
  return new Date(ms + offsetMin * MIN);
}

/** "10:00 AM", in branch time. */
export function clockTime(ms: number, offsetMin: number): string {
  const d = wallClock(ms, offsetMin);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "Saturday, 11 October 2026", in branch time. */
export function longDate(ms: number, offsetMin: number): string {
  const d = wallClock(ms, offsetMin);
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ` +
    `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  );
}

/**
 * "today", "tomorrow" or "on Saturday 11 October": the visit's day as the
 * salon's calendar sees it from now. A 24h reminder for a 10:00 visit sent
 * at 10:00 the day before says "tomorrow"; one for an evening visit booked
 * that morning says "today".
 */
export function dayPhrase(
  startAtMs: number,
  nowMs: number,
  offsetMin: number,
): string {
  const startDay = Math.floor(wallClock(startAtMs, offsetMin).getTime() / DAY);
  const today = Math.floor(wallClock(nowMs, offsetMin).getTime() / DAY);
  if (startDay === today) return 'today';
  if (startDay === today + 1) return 'tomorrow';
  const d = wallClock(startAtMs, offsetMin);
  return `on ${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "45 min", "1 h", "1 h 45 min". */
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const PAYMENT_DUE = 'A payment is still due for this booking.';

export function pushCopy(f: ReminderFacts): PushCopy {
  const time = clockTime(f.startAtMs, f.offsetMin);
  const when = dayPhrase(f.startAtMs, f.nowMs, f.offsetMin);
  const services = f.services.join(', ');
  const payment = f.paymentPending ? ` ${PAYMENT_DUE}` : '';

  switch (f.rung) {
    case 'confirm_24h':
      return {
        title: `Your appointment is ${when}`,
        body:
          `${services === '' ? 'Your visit' : services} at ${time}. ` +
          `Booking ${f.code}.${payment}`,
      };
    case 'day_of_3h':
      return {
        title: `See you ${when} at ${time}`,
        body: `${services === '' ? '' : `${services}. `}Booking ${f.code}.${payment}`,
      };
    case 'running_late_15m':
      return {
        title: `Your appointment starts at ${time}`,
        body: `Running late? Let the salon know. Booking ${f.code}.`,
      };
  }
}

export function emailCopy(f: ReminderFacts): EmailCopy {
  const time = clockTime(f.startAtMs, f.offsetMin);
  const when = dayPhrase(f.startAtMs, f.nowMs, f.offsetMin);
  const date = longDate(f.startAtMs, f.offsetMin);

  const subject =
    f.rung === 'confirm_24h'
      ? `Reminder: Your ${BRAND} appointment is ${when}`
      : f.rung === 'day_of_3h'
        ? `Reminder: Your ${BRAND} appointment is ${when} at ${time}`
        : `Your ${BRAND} appointment starts at ${time}`;

  const lines =
    f.rung === 'confirm_24h'
      ? [
          `This is a reminder that your ${BRAND} appointment is ${when} at ${time}.`,
          `Need to change it? Open the ${BRAND} app to manage your booking.`,
        ]
      : [
          `Your ${BRAND} appointment is ${when} at ${time}. We look forward to seeing you.`,
        ];

  const details = [
    { label: 'Date', value: date },
    { label: 'Time', value: time },
    ...(f.services.length > 0
      ? [{ label: 'Services', value: f.services.join(', ') }]
      : []),
    ...(f.durationMin > 0
      ? [{ label: 'Duration', value: durationLabel(f.durationMin) }]
      : []),
    { label: 'Booking code', value: f.code },
  ];

  return {
    subject,
    preheader: `${BRAND} · ${date} at ${time}`,
    heading: 'Appointment reminder',
    greeting: f.firstName === null ? 'Hi,' : `Hi ${f.firstName},`,
    lines,
    details,
    notes: f.paymentPending ? [PAYMENT_DUE] : [],
  };
}
