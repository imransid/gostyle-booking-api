/**
 * The rules of a mobile routine (a series booked from the app).
 *
 * PURE (CLAUDE.md 1): no ids are resolved, no clock is read, no row is
 * written. The caller passes today, now, the sessions as rows say they are,
 * and whether the salon is open on a day; this answers what the rules say.
 *
 * A routine is 2 to 6 sessions. EACH SESSION IS AN ORDINARY MOBILE BOOKING,
 * made by the single create, so a session costs what a single booking costs
 * and is cancelled by the single booking's rules. What is new here is only
 * what a routine adds on top: which days, what may change and when, and the
 * money for the three plans.
 *
 * The decisions (gostyle-customer-api docs/SERIES_BOOKING_AUDIT.md, C.1):
 *   D3 DAILY skips the days the salon is closed.
 *   D4 a day that is not free is never changed silently: up to 3 alternatives.
 *   D5 two no-shows in a row pause the routine.
 *   D6 a pause moves the remaining sessions to after the resume date.
 *   D7 products go on the first session only.
 *   D8 10% off only for UPFRONT, on the services, before VAT.
 *   D9 only no-shows marked by staff count for D5, unless switched on.
 */

import { Money } from '../shared/money';
import { VAT_PERCENT } from './quote';
import {
  addProducts,
  type MoneyFigures,
  type ProductMoney,
} from './mobile-products';
import {
  cancellationOutcome,
  type BookingStatus,
  type PolicyBand,
} from './lifecycle';
import {
  BOOKING_HORIZON_DAYS,
  addDays,
  daysBetween,
  expandSeries,
  weekdayOf,
  type Pattern,
  type TradingDay,
} from './recurrence';
import { OFFER_SPACING_MIN, isInsideDay } from '../availability/grid';

// ------------------------------------------------------------ the numbers

export const MIN_SESSIONS = 2;
export const MAX_SESSIONS = 6;
/** Inside this many hours of its start, a session cannot be skipped or moved. */
export const LOCK_HOURS = 24;
/** When the reminder goes (the event comes with the job; shown in the rules). */
export const REMINDER_HOURS = 48;
export const PAUSE_MAX_DAYS = 60;
export const EXTEND_MIN = 1;
export const EXTEND_MAX = 6;
/** Never more than this many sessions still to come, after an extend. */
export const MAX_FUTURE_SESSIONS = 6;
/** A session may be moved to a day up to this far ahead. */
export const RESCHEDULE_WITHIN_DAYS = BOOKING_HORIZON_DAYS;
/** D5. */
export const MISSES_TO_PAUSE = 2;
/** D4. */
export const MAX_ALTERNATIVES = 3;
/** D8. */
export const UPFRONT_DISCOUNT_PERCENT = 10;

/**
 * How far a walk for open days goes before it gives up. A salon closed for a
 * year is not a routine anyone can have, and the walk must not run forever.
 */
export const PLAN_SEARCH_DAYS = 366;

/** The rules as the app shows them on the confirm screen. */
export interface RoutineRules {
  readonly minSessions: number;
  readonly maxSessions: number;
  readonly lockHours: number;
  readonly reminderHours: number;
  readonly pauseMaxDays: number;
  readonly extendMax: number;
  readonly maxFutureSessions: number;
  readonly rescheduleWithinDays: number;
  readonly missesToPause: number;
}

export const ROUTINE_RULES: RoutineRules = {
  minSessions: MIN_SESSIONS,
  maxSessions: MAX_SESSIONS,
  lockHours: LOCK_HOURS,
  reminderHours: REMINDER_HOURS,
  pauseMaxDays: PAUSE_MAX_DAYS,
  extendMax: EXTEND_MAX,
  maxFutureSessions: MAX_FUTURE_SESSIONS,
  rescheduleWithinDays: RESCHEDULE_WITHIN_DAYS,
  missesToPause: MISSES_TO_PAUSE,
};

// ------------------------------------------------------------ vocabulary

export type Frequency =
  'DAILY' | 'WEEKLY' | 'EVERY_2_WEEKS' | 'MONTHLY' | 'CUSTOM';

export const FREQUENCIES: readonly Frequency[] = [
  'DAILY',
  'WEEKLY',
  'EVERY_2_WEEKS',
  'MONTHLY',
  'CUSTOM',
];

/** booking_series.frequency, CHECK series_frequency_known. */
export type FrequencyColumn =
  'daily' | 'weekly' | 'every_2_weeks' | 'monthly' | 'custom';

export function frequencyColumn(f: Frequency): FrequencyColumn {
  return f.toLowerCase() as FrequencyColumn;
}

export function frequencyFromColumn(column: string | null): Frequency | null {
  const f = (column ?? '').toUpperCase();
  return (FREQUENCIES as readonly string[]).includes(f)
    ? (f as Frequency)
    : null;
}

export type PaymentPlan = 'PAY_AT_SALON' | 'PAY_AS_YOU_GO' | 'UPFRONT';

export const PAYMENT_PLANS: readonly PaymentPlan[] = [
  'PAY_AT_SALON',
  'PAY_AS_YOU_GO',
  'UPFRONT',
];

/**
 * D2: what v1 books. The other two are worked out and shown, and refused on
 * create, because taking money in the app belongs to another team.
 */
export const V1_PAYMENT_PLANS: readonly PaymentPlan[] = ['PAY_AT_SALON'];

/** booking_series.payment_plan, CHECK series_payment_plan_known. */
export function paymentPlanColumn(
  p: PaymentPlan,
): 'pay_at_salon' | 'pay_as_you_go' | 'upfront' {
  return p.toLowerCase() as 'pay_at_salon' | 'pay_as_you_go' | 'upfront';
}

export type RoutineStatus = 'active' | 'paused' | 'ended' | 'completed';

export type RoutineAction =
  'SKIP' | 'RESCHEDULE' | 'EXTEND' | 'PAUSE' | 'RESUME';

export const ROUTINE_ACTIONS: readonly RoutineAction[] = [
  'SKIP',
  'RESCHEDULE',
  'EXTEND',
  'PAUSE',
  'RESUME',
];

/**
 * The app's pause picker, as the Figma lists it ("Busy Period" is BUSY).
 * `missed_twice` is the server's own (D5), never sent.
 */
export type PauseReason = 'TRAVEL' | 'HEALTH' | 'BUSY' | 'BUDGET' | 'OTHER';

export const PAUSE_REASONS: readonly PauseReason[] = [
  'TRAVEL',
  'HEALTH',
  'BUSY',
  'BUDGET',
  'OTHER',
];

/** The Figma's "Why are you cancelling?". Optional on a cancel. */
export type CancelReason =
  'NOT_SATISFIED' | 'TOO_EXPENSIVE' | 'MOVING' | 'OTHER';

export const CANCEL_REASONS: readonly CancelReason[] = [
  'NOT_SATISFIED',
  'TOO_EXPENSIVE',
  'MOVING',
  'OTHER',
];

/** What a rule refuses. The contract adds its own codes to these. */
export type RuleRefusalCode =
  | 'session_locked'
  | 'session_not_changeable'
  | 'routine_not_active'
  | 'invalid_sessions'
  | 'invalid_pause'
  | 'pause_too_long'
  | 'invalid_extend'
  | 'too_many_sessions'
  | 'reschedule_out_of_range'
  | 'session_day_taken'
  | 'invalid_pick';

export interface RuleRefusal {
  readonly field: string;
  readonly code: RuleRefusalCode;
  readonly message: string;
}

function refuse(
  field: string,
  code: RuleRefusalCode,
  message: string,
): RuleRefusal {
  return { field, code, message };
}

// ------------------------------------------------------------ days

export interface PlannedDay {
  readonly day: TradingDay;
  /** MONTHLY on the 31st landed on a shorter month's last day. */
  readonly movedFromDayOfMonth: number | null;
}

/** Is the salon open on this day? From the booking context, by the caller. */
export type IsOpen = (day: TradingDay) => boolean;

/** Every frequency with a cadence: all but CUSTOM. */
export type Cadence = Exclude<Frequency, 'CUSTOM'>;

/** 'YYYY-MM-DD' to its day of the month. */
function dayOfMonth(day: TradingDay): number {
  return Number(day.slice(8, 10));
}

/**
 * The shared expander, for the cadences it already knows.
 *
 * WEEKLY, EVERY_2_WEEKS and MONTHLY are the desk's every_n_weeks and
 * monthly_on_date, month-end fallback included (CLAUDE.md 4: share, do not
 * copy). Only DAILY is new, because it has to skip closed days (D3).
 */
function expand(pattern: Pattern, anchor: TradingDay, count: number) {
  return expandSeries(
    { anchor, startMin: 600, pattern, end: { kind: 'after_count', count } },
    { from: anchor, horizonDays: PLAN_SEARCH_DAYS },
  ).occurrences.map((o) => ({
    day: o.date,
    movedFromDayOfMonth: o.movedFromDayOfMonth,
  }));
}

/** The next `count` open days, from `from` on. D3: closed days do not count. */
function openDays(from: TradingDay, count: number, isOpen: IsOpen) {
  const days: PlannedDay[] = [];
  for (let i = 0; i < PLAN_SEARCH_DAYS && days.length < count; i += 1) {
    const day = addDays(from, i);
    if (isOpen(day)) days.push({ day, movedFromDayOfMonth: null });
  }
  return days;
}

/**
 * The days of a new routine, first day included.
 *
 * DAILY skips closed days, the first one too (D3). The others keep their
 * cadence whatever the salon does that day: a closed Tuesday on a weekly
 * routine is a day that is not free, which the customer sees with its
 * alternatives (D4). It is never moved here.
 *
 * Fewer than `count` days come back only when the salon is closed for a
 * whole year of DAILY. The caller refuses that.
 */
export function planDays(input: {
  readonly frequency: Cadence;
  readonly first: TradingDay;
  readonly count: number;
  readonly isOpen: IsOpen;
}): PlannedDay[] {
  const { first, count } = input;
  switch (input.frequency) {
    case 'DAILY':
      return openDays(first, count, input.isOpen);
    case 'WEEKLY':
      return expand({ kind: 'every_n_weeks', weeks: 1 }, first, count);
    case 'EVERY_2_WEEKS':
      return expand({ kind: 'every_n_weeks', weeks: 2 }, first, count);
    case 'MONTHLY':
      return expand(
        { kind: 'monthly_on_date', dayOfMonth: dayOfMonth(first) },
        first,
        count,
      );
  }
}

/** CUSTOM: the app's own days, ascending. The contract refuses repeats. */
export function customDays(days: readonly TradingDay[]): PlannedDay[] {
  return [...new Set(days)]
    .sort()
    .map((day) => ({ day, movedFromDayOfMonth: null }));
}

/**
 * EXTEND: more sessions after the last one.
 *
 * Counted from the LAST session's day, so a routine whose last session was
 * moved carries on from where it really is. MONTHLY keeps the day of the
 * month of the routine's first day (`anchor`): a routine on the 31st goes
 * back to the 31st after a February.
 */
export function continueDays(input: {
  readonly frequency: Cadence;
  readonly anchor: TradingDay;
  readonly last: TradingDay;
  readonly count: number;
  readonly isOpen: IsOpen;
}): PlannedDay[] {
  const { last, count } = input;
  switch (input.frequency) {
    case 'DAILY':
      return openDays(addDays(last, 1), count, input.isOpen);
    case 'WEEKLY':
    case 'EVERY_2_WEEKS': {
      const step = input.frequency === 'WEEKLY' ? 7 : 14;
      return Array.from({ length: count }, (_, i) => ({
        day: addDays(last, step * (i + 1)),
        movedFromDayOfMonth: null,
      }));
    }
    case 'MONTHLY':
      return expand(
        { kind: 'monthly_on_date', dayOfMonth: dayOfMonth(input.anchor) },
        addDays(last, 1),
        count,
      );
  }
}

/**
 * D6: the sessions being paused, planned again from the resume day. The
 * count is kept: as many days come back as were passed in.
 *
 * WEEKLY and EVERY_2_WEEKS restart on the routine's own weekday, on or after
 * `from`. MONTHLY keeps its day of the month. DAILY takes the next open
 * days. CUSTOM has no cadence, so its days all shift by the same number of
 * days, which keeps the gaps the customer chose.
 */
export function replanFrom(input: {
  readonly frequency: Frequency;
  readonly anchor: TradingDay;
  /** The days being moved, as they are now. */
  readonly remaining: readonly TradingDay[];
  /** The first day a session may land on. */
  readonly from: TradingDay;
  readonly isOpen: IsOpen;
}): PlannedDay[] {
  const count = input.remaining.length;
  if (count === 0) return [];
  const { from } = input;

  switch (input.frequency) {
    case 'DAILY':
      return openDays(from, count, input.isOpen);
    case 'WEEKLY':
    case 'EVERY_2_WEEKS': {
      const ahead = (weekdayOf(input.anchor) - weekdayOf(from) + 7) % 7;
      return expand(
        {
          kind: 'every_n_weeks',
          weeks: input.frequency === 'WEEKLY' ? 1 : 2,
        },
        addDays(from, ahead),
        count,
      );
    }
    case 'MONTHLY':
      return expand(
        { kind: 'monthly_on_date', dayOfMonth: dayOfMonth(input.anchor) },
        from,
        count,
      );
    case 'CUSTOM': {
      const sorted = [...input.remaining].sort();
      const shift = Math.max(0, daysBetween(sorted[0]!, from));
      return sorted.map((day) => ({
        day: addDays(day, shift),
        movedFromDayOfMonth: null,
      }));
    }
  }
}

/** The two cadences that live on a weekday. */
const WEEK_CADENCES: ReadonlySet<Frequency> = new Set<Frequency>([
  'WEEKLY',
  'EVERY_2_WEEKS',
]);

/**
 * RESUME: the remaining sessions, planned again from the first bookable day.
 *
 * The Figma's "Customize first" may switch the frequency (never to CUSTOM,
 * which needs its own dates). With no switch, or a switch to the same
 * frequency, this is replanFrom as it is.
 *
 * A switch between WEEKLY and EVERY_2_WEEKS KEEPS THE ROUTINE'S WEEKDAY, as
 * a plain resume does: the Figma shows "Same time slot: 4:30 PM, Sunday",
 * so a Sunday routine every 2 weeks is still on Sundays. Any other switch
 * starts its cadence on `from` itself: a daily or monthly cadence has no
 * weekday to keep, and the customer is choosing a new one now.
 *
 * The count is kept either way (D6). A new time or stylist does not change
 * the days, so it is not an input here: the caller books every session at
 * the new time with the new stylist, all or nothing.
 */
export function resumeDays(input: {
  readonly frequency: Frequency;
  readonly anchor: TradingDay;
  /** Null keeps the routine's frequency. */
  readonly newFrequency: Cadence | null;
  readonly remaining: readonly TradingDay[];
  readonly from: TradingDay;
  readonly isOpen: IsOpen;
}): PlannedDay[] {
  const switched =
    input.newFrequency !== null && input.newFrequency !== input.frequency;
  const keepsWeekday =
    switched &&
    WEEK_CADENCES.has(input.frequency) &&
    WEEK_CADENCES.has(input.newFrequency);
  return replanFrom({
    frequency: switched ? input.newFrequency : input.frequency,
    anchor: switched && !keepsWeekday ? input.from : input.anchor,
    remaining: input.remaining,
    from: input.from,
    isOpen: input.isOpen,
  });
}

/**
 * Past the booking horizon: stored as planned, booked by the job when the
 * diary reaches it (plan R8). A MONTHLY routine of 6 reaches this.
 */
export function beyondHorizon(day: TradingDay, today: TradingDay): boolean {
  return daysBetween(today, day) > BOOKING_HORIZON_DAYS;
}

// ------------------------------------------------------------ picks

/** One session as it will be booked: its day, its time, its stylist. */
export interface SessionSlot {
  /** The session's number in the routine (series_occurrence.index). */
  readonly index: number;
  readonly day: TradingDay;
  readonly startMin: number;
  readonly staffId: string;
  /** The customer chose this one from the alternatives (D4). */
  readonly picked: boolean;
}

/** A checked pick, as the contract hands it over. */
export interface PickChoice {
  readonly index: number;
  readonly day: TradingDay;
  readonly startMin: number;
  /** Null keeps the session's stylist. */
  readonly stylistId: string | null;
}

/**
 * D4: the customer's chosen alternatives, laid over what the action plans.
 *
 * Every pick must name a session this action plans (the create's sessions,
 * EXTEND's new ones, the ones PAUSE and RESUME move); anything else is
 * invalid_pick. Two sessions of a routine never share a day, so a pick onto
 * another session's day is session_day_taken. Whether the picked slot is
 * really free is the availability engine's answer, asked afterwards like
 * for every other session.
 */
export function applyPicks(
  planned: readonly SessionSlot[],
  picks: readonly PickChoice[],
  /** Days held by sessions this action does not plan (done, locked, kept). */
  otherDays: readonly TradingDay[] = [],
):
  | { readonly kind: 'ok'; readonly slots: SessionSlot[] }
  | { readonly kind: 'refused'; readonly refusal: RuleRefusal } {
  const known = new Set(planned.map((s) => s.index));
  for (const [i, p] of picks.entries()) {
    if (!known.has(p.index)) {
      return {
        kind: 'refused',
        refusal: refuse(
          `picks[${i}].index`,
          'invalid_pick',
          `Session ${p.index} is not one this change plans.`,
        ),
      };
    }
  }

  const chosen = new Map(picks.map((p) => [p.index, p]));
  const slots = planned.map((s): SessionSlot => {
    const p = chosen.get(s.index);
    if (p === undefined) return s;
    return {
      index: s.index,
      day: p.day,
      startMin: p.startMin,
      staffId: p.stylistId ?? s.staffId,
      picked: true,
    };
  });

  const taken = new Set(otherDays);
  for (const s of [...slots].sort((a, b) => a.index - b.index)) {
    if (taken.has(s.day)) {
      const at = picks.findIndex((p) => p.index === s.index);
      return {
        kind: 'refused',
        refusal: refuse(
          at === -1 ? 'picks' : `picks[${at}].date`,
          'session_day_taken',
          'Another session of this routine is already on that day.',
        ),
      };
    }
    taken.add(s.day);
  }
  return { kind: 'ok', slots };
}

// ------------------------------------------------------------ the lock

const HOUR_MS = 60 * 60 * 1000;

/** Inside 24h of its start (or already started), a session is locked. */
export function isLocked(startAtMs: number, nowMs: number): boolean {
  return startAtMs - nowMs < LOCK_HOURS * HOUR_MS;
}

/**
 * What the app shows for a session still to come: SCHEDULED before the lock,
 * CONFIRMED inside it (plan R9). DERIVED from the clock on every read, never
 * stored, so it cannot go stale.
 */
export type SessionPhase = 'SCHEDULED' | 'CONFIRMED';

export function sessionPhase(startAtMs: number, nowMs: number): SessionPhase {
  return isLocked(startAtMs, nowMs) ? 'CONFIRMED' : 'SCHEDULED';
}

// ------------------------------------------------------------ sessions

export type OccurrenceState =
  'planned' | 'materialised' | 'needs_attention' | 'skipped' | 'detached';

/** One session, as its rows say it is. */
export interface SessionFacts {
  /** series_occurrence.id: what the app sends back to skip or move it. */
  readonly id: string;
  readonly index: number;
  readonly day: TradingDay;
  /**
   * The booking's start when there is one, else the planned day and minute
   * on the branch clock. Always set, so the lock applies to every session.
   */
  readonly startAtMs: number;
  readonly state: OccurrenceState;
  /** The linked booking's status. Null while nothing is booked. */
  readonly bookingStatus: BookingStatus | null;
  /**
   * Who marked the no-show (booking_status_history.actor_kind, staff and
   * manager both being `staff`). Null unless the status is no_show.
   */
  readonly noShowBy: 'staff' | 'system' | null;
}

/** The visit happened. */
const VISITED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

/** Over: visited, or missed. */
const DONE: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  ...VISITED,
  'no_show',
]);

/** Will not happen, and was not skipped through the routine. */
const CANCELLED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'cancelled',
  'expired',
  'rescheduled',
  'skipped',
]);

export type SessionBucket = 'done' | 'remaining' | 'skipped' | 'cancelled';

/**
 * Exactly one bucket per session. A skip through the routine wins over the
 * booking's own status (the skip is what cancelled it). A booking cancelled
 * any other way, at the desk for example, is `cancelled`, shown apart.
 */
export function sessionBucket(s: SessionFacts): SessionBucket {
  if (s.state === 'skipped') return 'skipped';
  if (s.bookingStatus !== null) {
    if (DONE.has(s.bookingStatus)) return 'done';
    if (CANCELLED.has(s.bookingStatus)) return 'cancelled';
  }
  return 'remaining';
}

function byDay(a: SessionFacts, b: SessionFacts): number {
  return a.day === b.day ? a.index - b.index : a.day < b.day ? -1 : 1;
}

export interface Tally {
  /** done + remaining: the sessions that did or will happen. "1 of 5". */
  readonly total: number;
  readonly done: number;
  readonly remaining: number;
  readonly skipped: number;
  readonly cancelled: number;
  /** The first session still to come, or null. */
  readonly next: SessionFacts | null;
}

/** "1 of 6 done, 5 remaining". DERIVED on every read, never stored. */
export function tally(sessions: readonly SessionFacts[], nowMs: number): Tally {
  const count = { done: 0, remaining: 0, skipped: 0, cancelled: 0 };
  for (const s of sessions) count[sessionBucket(s)] += 1;
  const next =
    [...sessions]
      .filter((s) => sessionBucket(s) === 'remaining' && s.startAtMs > nowMs)
      .sort(byDay)[0] ?? null;
  return { total: count.done + count.remaining, ...count, next };
}

/** A session is only changed while it is still to come and not locked. */
export function changeRefusal(
  s: SessionFacts,
  nowMs: number,
): RuleRefusal | null {
  if (sessionBucket(s) !== 'remaining') {
    return refuse(
      'session_ids',
      'session_not_changeable',
      'This session is already done, skipped or cancelled.',
    );
  }
  if (isLocked(s.startAtMs, nowMs)) {
    return refuse(
      'session_ids',
      'session_locked',
      `A session cannot be skipped or moved in the ${LOCK_HOURS} hours before it starts.`,
    );
  }
  return null;
}

/** SKIP, RESCHEDULE, EXTEND and PAUSE need an active routine; RESUME a paused one. */
export function actionRefusal(
  action: RoutineAction,
  status: RoutineStatus,
): RuleRefusal | null {
  const needs: RoutineStatus = action === 'RESUME' ? 'paused' : 'active';
  if (status === needs) return null;
  return refuse(
    'action',
    'routine_not_active',
    action === 'RESUME'
      ? 'Only a paused routine can be resumed.'
      : `This routine is ${status}. Only an active routine can be changed.`,
  );
}

/**
 * One session's state in the app's words. DERIVED from the rows and the
 * clock on every read, never stored.
 *
 *   SCHEDULED / CONFIRMED  booked and still to come: before / inside the lock
 *   PLANNED                past the 90 day horizon, not booked yet
 *   NEEDS_ACTION           could not be booked; the customer must choose
 *   CHECKED_IN, COMPLETED  the visit happened (or is happening)
 *   MISSED                 a no-show
 *   SKIPPED                skipped through the routine
 *   CANCELLED              cancelled any other way (the desk, for example)
 */
export type SessionWord =
  | 'SCHEDULED'
  | 'CONFIRMED'
  | 'PLANNED'
  | 'NEEDS_ACTION'
  | 'CHECKED_IN'
  | 'COMPLETED'
  | 'MISSED'
  | 'SKIPPED'
  | 'CANCELLED';

export function sessionWord(s: SessionFacts, nowMs: number): SessionWord {
  switch (sessionBucket(s)) {
    case 'skipped':
      return 'SKIPPED';
    case 'cancelled':
      return 'CANCELLED';
    case 'done':
      if (s.bookingStatus === 'no_show') return 'MISSED';
      return s.bookingStatus === 'checked_in' ||
        s.bookingStatus === 'in_service'
        ? 'CHECKED_IN'
        : 'COMPLETED';
    case 'remaining':
      if (s.state === 'needs_attention') return 'NEEDS_ACTION';
      if (s.bookingStatus === null) return 'PLANNED';
      return sessionPhase(s.startAtMs, nowMs);
  }
}

/** What the customer may do right now, for the hub's buttons. */
export interface RoutineCan {
  readonly skip: boolean;
  readonly reschedule: boolean;
  readonly extend: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
}

/**
 * The hub's buttons, from the same rules the PATCH applies, so a button is
 * never shown for an action the server would refuse.
 */
export function routineCan(
  status: RoutineStatus,
  sessions: readonly SessionFacts[],
  nowMs: number,
): RoutineCan {
  const active = status === 'active';
  const changeable = sessions.some((s) => changeRefusal(s, nowMs) === null);
  const future = sessions.filter(
    (s) => sessionBucket(s) === 'remaining' && s.startAtMs > nowMs,
  ).length;
  return {
    skip: active && changeable,
    reschedule: active && changeable,
    extend: active && future < MAX_FUTURE_SESSIONS,
    pause: active,
    resume: status === 'paused',
    cancel: (active || status === 'paused') && future > 0,
  };
}

/** SKIP: every id is a session of this routine that may still change. */
export function checkSkip(
  sessions: readonly SessionFacts[],
  ids: readonly string[],
  nowMs: number,
): RuleRefusal | null {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    return refuse(
      'session_ids',
      'invalid_sessions',
      'Name each session to skip once.',
    );
  }
  for (const id of ids) {
    const s = sessions.find((x) => x.id === id);
    if (s === undefined) {
      return refuse(
        'session_ids',
        'invalid_sessions',
        'That session is not part of this routine.',
      );
    }
    const why = changeRefusal(s, nowMs);
    if (why !== null) return why;
  }
  return null;
}

/**
 * RESCHEDULE one session.
 *
 * The session itself must still be changeable. The new time must be past
 * the lock (a move into the last 24 hours would be a session nobody could
 * change again) and within 90 days, and not on a day another session of the
 * routine already has.
 */
export function checkReschedule(input: {
  readonly sessions: readonly SessionFacts[];
  readonly sessionId: string;
  readonly newDay: TradingDay;
  readonly newStartAtMs: number;
  readonly today: TradingDay;
  readonly nowMs: number;
}): RuleRefusal | null {
  const s = input.sessions.find((x) => x.id === input.sessionId);
  if (s === undefined) {
    return refuse(
      'session_id',
      'invalid_sessions',
      'That session is not part of this routine.',
    );
  }
  const why = changeRefusal(s, input.nowMs);
  if (why !== null) return { ...why, field: 'session_id' };

  if (
    isLocked(input.newStartAtMs, input.nowMs) ||
    daysBetween(input.today, input.newDay) > RESCHEDULE_WITHIN_DAYS
  ) {
    return refuse(
      'date',
      'reschedule_out_of_range',
      `Pick a time at least ${LOCK_HOURS} hours ahead and within ${RESCHEDULE_WITHIN_DAYS} days.`,
    );
  }
  const clash = input.sessions.some(
    (x) =>
      x.id !== s.id &&
      x.day === input.newDay &&
      (sessionBucket(x) === 'remaining' || sessionBucket(x) === 'done'),
  );
  if (clash) {
    return refuse(
      'date',
      'session_day_taken',
      'Another session of this routine is already on that day.',
    );
  }
  return null;
}

/** EXTEND by 1 to 6, never past 6 sessions still to come. */
export function checkExtend(
  sessions: readonly SessionFacts[],
  add: number,
  nowMs: number,
): RuleRefusal | null {
  if (!Number.isInteger(add) || add < EXTEND_MIN || add > EXTEND_MAX) {
    return refuse(
      'sessions',
      'invalid_extend',
      `Add ${EXTEND_MIN} to ${EXTEND_MAX} sessions.`,
    );
  }
  const future = sessions.filter(
    (s) => sessionBucket(s) === 'remaining' && s.startAtMs > nowMs,
  ).length;
  if (future + add > MAX_FUTURE_SESSIONS) {
    const room = Math.max(0, MAX_FUTURE_SESSIONS - future);
    return refuse(
      'sessions',
      'too_many_sessions',
      room === 0
        ? `This routine already has ${future} sessions to come, the most it can have.`
        : `This routine has ${future} sessions to come. Add at most ${room}.`,
    );
  }
  return null;
}

/** PAUSE until a day after today, at most 60 days away. */
export function checkPause(
  until: TradingDay,
  today: TradingDay,
): RuleRefusal | null {
  const days = daysBetween(today, until);
  if (days < 1) {
    return refuse(
      'until',
      'invalid_pause',
      'The resume date must be after today.',
    );
  }
  if (days > PAUSE_MAX_DAYS) {
    return refuse(
      'until',
      'pause_too_long',
      `A routine can be paused for at most ${PAUSE_MAX_DAYS} days.`,
    );
  }
  return null;
}

/**
 * The sessions a pause moves (D6): still to come and not locked. A session
 * inside the lock stays where it is, as it would for a skip.
 */
export function sessionsToMove(
  sessions: readonly SessionFacts[],
  nowMs: number,
): SessionFacts[] {
  return sessions.filter((s) => changeRefusal(s, nowMs) === null).sort(byDay);
}

/**
 * The pause as the app sees it.
 *
 * NULL UNLESS THE STATUS IS PAUSED. The desk's resume sets `active` and does
 * not know paused_until exists, so the column can outlive the pause. The
 * migration has no CHECK for it on purpose (a CHECK would break the desk's
 * resume); this is where the rule lives instead.
 */
export function effectivePause(row: {
  readonly status: RoutineStatus;
  readonly pausedUntil: TradingDay | null;
  readonly pauseReason: string | null;
  readonly pauseNote: string | null;
}): {
  readonly until: TradingDay | null;
  readonly reason: string | null;
  readonly note: string | null;
} | null {
  if (row.status !== 'paused') return null;
  return {
    until: row.pausedUntil,
    reason: row.pauseReason,
    note: row.pauseNote,
  };
}

// ------------------------------------------------------------ two misses

export interface MissVerdict {
  readonly pause: boolean;
  /**
   * The day of the latest miss that counted. Stored as miss_streak_after
   * when the routine is paused, so the same two misses never pause it again
   * after a resume.
   */
  readonly lastMissDay: TradingDay | null;
}

/**
 * D5 and D9: the last two sessions that count are both no-shows.
 *
 * Walked from the most recent session backwards, only sessions after
 * `after` (miss_streak_after):
 *   - a visit that happened breaks the streak;
 *   - a no-show marked by staff counts, and so does one the sweeper marked
 *     when `countAutoNoShows` is on (D9);
 *   - anything else is passed over: a skipped or cancelled session, a
 *     session still to come, and (switch off) the sweeper's own no-show,
 *     which says nothing either way about the customer.
 */
export function twoMissesInARow(
  sessions: readonly SessionFacts[],
  opts: {
    readonly countAutoNoShows: boolean;
    readonly after: TradingDay | null;
  },
): MissVerdict {
  const walk = sessions
    .filter((s) => opts.after === null || s.day > opts.after)
    .sort(byDay)
    .reverse();

  let streak = 0;
  let lastMissDay: TradingDay | null = null;
  for (const s of walk) {
    if (s.state === 'skipped' || s.bookingStatus === null) continue;
    if (VISITED.has(s.bookingStatus)) break;
    if (s.bookingStatus !== 'no_show') continue;

    const counts =
      s.noShowBy === 'staff' ||
      (opts.countAutoNoShows && s.noShowBy === 'system');
    if (!counts) continue;

    streak += 1;
    lastMissDay ??= s.day;
    if (streak >= MISSES_TO_PAUSE) return { pause: true, lastMissDay };
  }
  return { pause: false, lastMissDay: null };
}

// ------------------------------------------------------------ cancel

export interface CancelLine {
  readonly id: string;
  readonly index: number;
  readonly day: TradingDay;
  readonly capturedFils: number;
  readonly refundFils: number;
  readonly keptFils: number;
  readonly band: PolicyBand;
  readonly lateCancel: boolean;
  /** Inside the 24h lock: cancelled under the single booking's late rules. */
  readonly locked: boolean;
}

export interface CancelSummary {
  readonly sessions: readonly CancelLine[];
  readonly capturedFils: number;
  readonly refundFils: number;
  readonly keptFils: number;
  readonly lateCount: number;
}

/**
 * What cancelling the routine does, session by session, BEFORE it is done.
 *
 * Every session still to come is cancelled, each by the single booking's own
 * refund bands (cancellationOutcome). Nothing new is invented for a routine:
 * the summary is the sum of what the single cancel would do to each one.
 *
 * paidInFull is false because the lifecycle repository passes false today
 * (plan K14). The summary must say what the cancel will really do, not what
 * the policy table says; when K14 is fixed, both change together.
 */
export function cancelSummary(
  sessions: readonly (SessionFacts & { readonly capturedFils: number })[],
  nowMs: number,
): CancelSummary {
  const lines = sessions
    .filter((s) => sessionBucket(s) === 'remaining' && s.startAtMs > nowMs)
    .sort(byDay)
    .map((s): CancelLine => {
      const out = cancellationOutcome({
        nowMs,
        startAtMs: s.startAtMs,
        capturedFils: s.capturedFils,
        paidInFull: false,
        initiatedBy: 'customer',
      });
      return {
        id: s.id,
        index: s.index,
        day: s.day,
        capturedFils: s.capturedFils,
        refundFils: out.refundFils,
        keptFils: out.keptFils,
        band: out.band,
        lateCancel: out.lateCancel,
        locked: isLocked(s.startAtMs, nowMs),
      };
    });

  const sum = (pick: (l: CancelLine) => number) =>
    Money.sum(lines.map((l) => Money.fils(pick(l)))).fils;
  return {
    sessions: lines,
    capturedFils: sum((l) => l.capturedFils),
    refundFils: sum((l) => l.refundFils),
    keptFils: sum((l) => l.keptFils),
    lateCount: lines.filter((l) => l.lateCancel).length,
  };
}

// ------------------------------------------------------------ money

export interface PlanSession {
  readonly totalFils: number;
  readonly payNowFils: number;
  /** What is left to pay at that visit. */
  readonly atVisitFils: number;
}

export interface PlanMoney {
  readonly plan: PaymentPlan;
  /** D2: only PAY_AT_SALON can be booked in v1. */
  readonly available: boolean;
  /** Services and products, net, before any discount. */
  readonly subtotalFils: number;
  readonly discountFils: number;
  readonly vatFils: number;
  readonly totalFils: number;
  readonly payNowFils: number;
  /** The deposit percent (PAY_AS_YOU_GO) or the discount percent (UPFRONT). */
  readonly percent: number | null;
  readonly sessions: readonly PlanSession[];
}

export interface RoutineMoney {
  /** Each session as the single create will charge it; products on the first. */
  readonly sessions: readonly MoneyFigures[];
  readonly plans: Readonly<Record<PaymentPlan, PlanMoney>>;
}

/**
 * What the routine costs under each plan.
 *
 * `sessions` are the SERVICES' figures of each session, from the same quote
 * the single create checks against (tier discount and all), one per session
 * in order. `products` go on the first session only (D7).
 *
 *   PAY_AT_SALON   the sum of the sessions. Nothing now.
 *   PAY_AS_YOU_GO  the same sum. Each session's deposit is `depositPercent`
 *                  of that session, rounded per session because each session
 *                  is its own booking with its own deposit, and all of them
 *                  are taken at create. The rest is paid at each visit.
 *   UPFRONT        D8: 10% off the services (after any tier discount),
 *                  before VAT, rounded once; VAT once on what is left.
 *                  Products are never discounted and keep their own VAT.
 *                  Everything now.
 */
export function routineMoney(input: {
  readonly sessions: readonly MoneyFigures[];
  readonly products: ProductMoney;
  readonly depositPercent: number;
}): RoutineMoney {
  if (input.sessions.length === 0) throw new Error('a routine needs sessions');
  const p = input.depositPercent;
  if (!Number.isInteger(p) || p < 0 || p > 100) {
    throw new Error(`depositPercent must be 0 to 100, got ${p}`);
  }

  const sessions = input.sessions.map((s, i) =>
    i === 0 ? addProducts(s, input.products) : s,
  );
  const sum = (pick: (f: MoneyFigures) => number) =>
    Money.sum(sessions.map((s) => Money.fils(pick(s)))).fils;
  const whole = {
    subtotalFils: sum((s) => s.subtotalFils),
    discountFils: sum((s) => s.discountFils),
    vatFils: sum((s) => s.vatFils),
    totalFils: sum((s) => s.totalFils),
  };

  const atSalon: PlanMoney = {
    plan: 'PAY_AT_SALON',
    available: V1_PAYMENT_PLANS.includes('PAY_AT_SALON'),
    ...whole,
    payNowFils: 0,
    percent: null,
    sessions: sessions.map((s) => ({
      totalFils: s.totalFils,
      payNowFils: 0,
      atVisitFils: s.totalFils,
    })),
  };

  const deposits = sessions.map((s) => Money.fils(s.totalFils).percent(p).fils);
  const asYouGo: PlanMoney = {
    plan: 'PAY_AS_YOU_GO',
    available: V1_PAYMENT_PLANS.includes('PAY_AS_YOU_GO'),
    ...whole,
    payNowFils: Money.sum(deposits.map((d) => Money.fils(d))).fils,
    percent: p,
    sessions: sessions.map((s, i) => ({
      totalFils: s.totalFils,
      payNowFils: deposits[i]!,
      atVisitFils: s.totalFils - deposits[i]!,
    })),
  };

  const services = Money.sum(
    input.sessions.map((s) => Money.fils(s.subtotalFils - s.discountFils)),
  );
  const offUpfront = services.percent(UPFRONT_DISCOUNT_PERCENT);
  const servicesNet = services.minus(offUpfront);
  const servicesVat = servicesNet.percent(VAT_PERCENT);
  const upfrontTotal = servicesNet
    .plus(servicesVat)
    .plus(Money.fils(input.products.totalFils));
  const shares = upfrontTotal.isZero()
    ? sessions.map(() => 0)
    : upfrontTotal
        .allocate(sessions.map((s) => Math.max(s.totalFils, 1)))
        .map((m) => m.fils);
  const upfront: PlanMoney = {
    plan: 'UPFRONT',
    available: V1_PAYMENT_PLANS.includes('UPFRONT'),
    subtotalFils: whole.subtotalFils,
    discountFils: whole.discountFils + offUpfront.fils,
    vatFils: servicesVat.fils + input.products.vatFils,
    totalFils: upfrontTotal.fils,
    payNowFils: upfrontTotal.fils,
    percent: UPFRONT_DISCOUNT_PERCENT,
    sessions: shares.map((share) => ({
      totalFils: share,
      payNowFils: share,
      atVisitFils: 0,
    })),
  };

  return {
    sessions,
    plans: {
      PAY_AT_SALON: atSalon,
      PAY_AS_YOU_GO: asYouGo,
      UPFRONT: upfront,
    },
  };
}

// ------------------------------------------------------------ times

/**
 * dry_run without a time: the start minutes free on EVERY day of the
 * routine, ascending. One day with nothing free means nothing is free on all
 * of them. Only minutes a series row can store (the desk's 10:00 to 22:00
 * CHECK) come back.
 */
export function timesFreeOnAll(
  perDay: readonly (readonly number[])[],
): number[] {
  if (perDay.length === 0) return [];
  let common = new Set(perDay[0]!.filter(isInsideDay));
  for (const day of perDay.slice(1)) {
    const here = new Set(day);
    common = new Set([...common].filter((m) => here.has(m)));
  }
  return [...common].sort((a, b) => a - b);
}

export interface SlotChoice {
  readonly day: TradingDay;
  readonly startMin: number;
  readonly staffId: string;
}

/**
 * D4: up to three alternatives for a session whose day is not free.
 *
 * In this order, nearest first inside each:
 *   1. the same stylist, the same day, another time;
 *   2. another stylist, the same day, the same time;
 *   3. the same stylist, the same time, another day;
 *   4. another stylist, the same day, another time.
 * The customer picks one; nothing is chosen for them. Days other sessions
 * of the routine already have are never offered, and two offers with the
 * same stylist on the same day are at least OFFER_SPACING_MIN apart, so the
 * three are real choices, not three faces of the same half hour.
 */
export function pickAlternatives(input: {
  readonly wanted: SlotChoice;
  readonly free: readonly SlotChoice[];
  readonly otherSessionDays: readonly TradingDay[];
  readonly max?: number;
}): SlotChoice[] {
  const { wanted } = input;
  const max = input.max ?? MAX_ALTERNATIVES;
  const blocked = new Set(input.otherSessionDays);

  const rank = (c: SlotChoice): [number, number, number] | null => {
    const sameStaff = c.staffId === wanted.staffId;
    const sameDay = c.day === wanted.day;
    const sameTime = c.startMin === wanted.startMin;
    const minutes = Math.abs(c.startMin - wanted.startMin);
    const days = Math.abs(daysBetween(wanted.day, c.day));
    if (sameStaff && sameDay && sameTime) return null;
    if (sameStaff && sameDay) return [0, minutes, 0];
    if (sameDay && sameTime) return [1, 0, 0];
    if (sameStaff && sameTime) return [2, days, 0];
    if (sameDay) return [3, minutes, 0];
    return null;
  };

  const ranked = input.free
    .filter((c) => isInsideDay(c.startMin) && !blocked.has(c.day))
    .map((c) => ({ c, r: rank(c) }))
    .filter(
      (x): x is { c: SlotChoice; r: [number, number, number] } => x.r !== null,
    )
    .sort(
      (a, b) =>
        a.r[0] - b.r[0] ||
        a.r[1] - b.r[1] ||
        a.c.startMin - b.c.startMin ||
        (a.c.day < b.c.day ? -1 : a.c.day > b.c.day ? 1 : 0) ||
        (a.c.staffId < b.c.staffId ? -1 : a.c.staffId > b.c.staffId ? 1 : 0),
    );

  const picked: SlotChoice[] = [];
  for (const { c } of ranked) {
    if (picked.length >= max) break;
    const tooClose = picked.some(
      (p) =>
        p.day === c.day &&
        p.staffId === c.staffId &&
        Math.abs(p.startMin - c.startMin) < OFFER_SPACING_MIN,
    );
    if (!tooClose) picked.push(c);
  }
  return picked;
}
