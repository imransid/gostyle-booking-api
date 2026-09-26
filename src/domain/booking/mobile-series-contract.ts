import { aedToFils, amountsAgree, filsToAed } from './mobile-contract';
import {
  EXTEND_MAX,
  EXTEND_MIN,
  FREQUENCIES,
  MAX_SESSIONS,
  MIN_SESSIONS,
  PAUSE_REASONS,
  PAYMENT_PLANS,
  ROUTINE_ACTIONS,
  V1_PAYMENT_PLANS,
  type Frequency,
  type PauseReason,
  type PaymentPlan,
  type PlanMoney,
  type RoutineStatus,
  type RuleRefusalCode,
} from './mobile-series';
import {
  BOOKING_HORIZON_DAYS,
  daysBetween,
  type TradingDay,
} from './recurrence';
import { SLOT_MIN, isInsideDay } from '../availability/grid';

/**
 * The rules a routine request must meet before anything is looked up, held
 * or booked (gostyle-customer-api docs/SERIES_BOOKING_AUDIT.md, E.3).
 *
 * PURE: no ids are resolved here. Whether a service is sold at the salon, or
 * a day is free, is answered further in. This only says whether the request
 * makes sense on its own, in the app's words, and it runs even though
 * gostyle-customer-api checks the same things first: this service does not
 * trust a body because it came from a neighbour.
 *
 * What depends on the routine's rows (the lock, the status, how many
 * sessions are still to come) is in mobile-series.ts, which this imports.
 */

// ------------------------------------------------------------ codes

/** Every code a routine route can answer. */
export type SeriesRefusalCode =
  | RuleRefusalCode
  | 'no_services'
  | 'unknown_service'
  | 'stylist_required'
  | 'invalid_frequency'
  | 'invalid_session_count'
  | 'invalid_date'
  | 'date_out_of_range'
  | 'time_required'
  | 'invalid_time'
  | 'invalid_payment_plan'
  | 'payment_plan_not_available'
  | 'invalid_pick'
  | 'amount_mismatch'
  | 'session_not_free'
  | 'invalid_action'
  | 'invalid_pause_reason'
  | 'not_found'
  | 'cannot_cancel';

/**
 * The same list as a value, for the specs and the docs. The spec beside
 * mobile-booking.error.ts proves each one is a MobileErrorCode and comes out
 * in the app's envelope.
 */
export const SERIES_REFUSAL_CODES: readonly SeriesRefusalCode[] = [
  'no_services',
  'unknown_service',
  'stylist_required',
  'invalid_frequency',
  'invalid_session_count',
  'invalid_date',
  'date_out_of_range',
  'time_required',
  'invalid_time',
  'invalid_payment_plan',
  'payment_plan_not_available',
  'invalid_pick',
  'amount_mismatch',
  'session_not_free',
  'invalid_action',
  'invalid_sessions',
  'session_locked',
  'session_not_changeable',
  'routine_not_active',
  'invalid_pause',
  'pause_too_long',
  'invalid_pause_reason',
  'invalid_extend',
  'too_many_sessions',
  'reschedule_out_of_range',
  'session_day_taken',
  'not_found',
  'cannot_cancel',
];

/**
 * The HTTP status of each code.
 *
 * `session_not_free` is 409, like the single create's slot_taken: a race,
 * not a mistake. The app runs dry_run again and shows the alternatives.
 * `not_found` is 404, never 403, for an id the caller may not see.
 * Everything else is a field the customer can fix: 422.
 */
export function refusalStatus(code: SeriesRefusalCode): number {
  if (code === 'session_not_free') return 409;
  if (code === 'not_found') return 404;
  return 422;
}

export interface SeriesRefusal {
  readonly field: string;
  readonly code: SeriesRefusalCode;
  readonly message: string;
  /** The server's figure on amount_mismatch, decimal AED. */
  readonly expected?: number;
}

function refuse(
  field: string,
  code: SeriesRefusalCode,
  message: string,
): SeriesRefusal {
  return { field, code, message };
}

export type Checked<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly refusal: SeriesRefusal };

const ok = <T>(value: T): Checked<T> => ({ kind: 'ok', value });
const no = <T>(refusal: SeriesRefusal): Checked<T> => ({
  kind: 'refused',
  refusal,
});

// ------------------------------------------------------------ words

/** booking_series.status to the app's word. */
export type RoutineWireStatus = 'ACTIVE' | 'PAUSED' | 'ENDED' | 'COMPLETED';

export function toRoutineStatus(status: RoutineStatus): RoutineWireStatus {
  return status.toUpperCase() as RoutineWireStatus;
}

/** booking_series.pause_reason, CHECK series_pause_reason_known. */
export function pauseReasonColumn(
  r: PauseReason,
): 'travel' | 'health' | 'budget' | 'other' {
  return r.toLowerCase() as 'travel' | 'health' | 'budget' | 'other';
}

/** The column back to the app's word. `missed_twice` is the server's (D5). */
export function pauseReasonFromColumn(
  column: string | null,
): PauseReason | 'MISSED_TWICE' | null {
  if (column === null) return null;
  const word = column.toUpperCase();
  if (word === 'MISSED_TWICE') return word;
  return (PAUSE_REASONS as readonly string[]).includes(word)
    ? (word as PauseReason)
    : null;
}

// ------------------------------------------------------------ day and time

/** A real calendar day, 'YYYY-MM-DD'. 2026-02-30 is not one. */
export function isTradingDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * 'HH:MM' to minutes past midnight, or null.
 *
 * On the 5 minute grid, and inside the desk's trading day (10:00 to 21:55):
 * booking_series and series_occurrence both CHECK that, so a routine at
 * 09:00 would fail at the insert. Refused here, in the app's words, instead.
 */
export function parseRoutineTime(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (m === null) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute % SLOT_MIN === 0 && isInsideDay(minute) ? minute : null;
}

/** A session day: today at the earliest, inside the 90 day horizon. */
function inBookingRange(day: TradingDay, today: TradingDay): boolean {
  const ahead = daysBetween(today, day);
  return ahead >= 0 && ahead <= BOOKING_HORIZON_DAYS;
}

const TIME_MESSAGE = 'time is HH:MM, on a 5 minute step, from 10:00 to 21:55.';

// ------------------------------------------------------------ create

/** One alternative the customer chose for a session (D4). */
export interface PickClaim {
  readonly index: number;
  readonly date: string;
  readonly time: string;
  /** Null keeps the routine's stylist. */
  readonly stylistId: string | null;
}

/** POST /v1/mobile-booking/series, as the app sent it. */
export interface RoutineClaim {
  readonly dryRun: boolean;
  readonly serviceIds: readonly string[];
  readonly stylistId: string | null;
  readonly frequency: string;
  /** Not CUSTOM: the first day. */
  readonly startDate: string | null;
  /** Not CUSTOM: how many sessions. */
  readonly sessions: number | null;
  /** CUSTOM only: every day. */
  readonly dates: readonly string[] | null;
  readonly time: string | null;
  readonly paymentPlan: string;
  readonly picks: readonly PickClaim[];
}

export interface CheckedPick {
  readonly index: number;
  readonly day: TradingDay;
  readonly startMin: number;
  readonly stylistId: string | null;
}

export interface CheckedRoutine {
  readonly dryRun: boolean;
  readonly frequency: Frequency;
  readonly count: number;
  /** The first day, for every frequency but CUSTOM. */
  readonly first: TradingDay | null;
  /** CUSTOM only: the days, ascending. */
  readonly days: readonly TradingDay[] | null;
  /** Null only on a dry_run that asks which times are free. */
  readonly startMin: number | null;
  readonly paymentPlan: PaymentPlan;
  readonly picks: readonly CheckedPick[];
}

/**
 * The create (or its dry_run), on its own. In the order a customer would fix
 * them: what, who, how often, when, how to pay, then the picks.
 *
 * `today` is the branch's own day, from the caller's clock.
 */
export function checkRoutine(
  claim: RoutineClaim,
  today: TradingDay,
): Checked<CheckedRoutine> {
  if (claim.serviceIds.length === 0) {
    return no(refuse('services', 'no_services', 'Pick at least one service.'));
  }
  if ((claim.stylistId ?? '').trim() === '') {
    return no(
      refuse(
        'stylist_id',
        'stylist_required',
        'A routine keeps one regular stylist. Choose one.',
      ),
    );
  }
  if (!(FREQUENCIES as readonly string[]).includes(claim.frequency)) {
    return no(
      refuse(
        'frequency',
        'invalid_frequency',
        'frequency must be DAILY, WEEKLY, EVERY_2_WEEKS, MONTHLY or CUSTOM.',
      ),
    );
  }
  const frequency = claim.frequency as Frequency;

  // ---- the days
  let count: number;
  let first: TradingDay | null = null;
  let days: TradingDay[] | null = null;

  if (frequency === 'CUSTOM') {
    if (claim.dates === null || claim.startDate !== null) {
      return no(
        refuse(
          'dates',
          'invalid_date',
          'A CUSTOM routine sends its days in dates, and no start_date.',
        ),
      );
    }
    const at = claim.dates.findIndex((d) => !isTradingDay(d));
    if (at !== -1) {
      return no(
        refuse(`dates[${at}]`, 'invalid_date', 'A date is YYYY-MM-DD.'),
      );
    }
    if (new Set(claim.dates).size !== claim.dates.length) {
      return no(refuse('dates', 'invalid_date', 'Pick each day once.'));
    }
    count = claim.dates.length;
    if (claim.sessions !== null && claim.sessions !== count) {
      return no(
        refuse(
          'sessions',
          'invalid_session_count',
          'For a CUSTOM routine, sessions is the number of dates. Leave it out.',
        ),
      );
    }
    days = [...claim.dates].sort();
    const out = days.findIndex((d) => !inBookingRange(d, today));
    if (out !== -1) {
      return no(
        refuse(
          'dates',
          'date_out_of_range',
          `Every day must be from today to ${BOOKING_HORIZON_DAYS} days ahead.`,
        ),
      );
    }
  } else {
    if (claim.dates !== null) {
      return no(
        refuse(
          'dates',
          'invalid_date',
          'Only a CUSTOM routine sends dates. Send start_date and sessions.',
        ),
      );
    }
    if (claim.startDate === null || !isTradingDay(claim.startDate)) {
      return no(
        refuse('start_date', 'invalid_date', 'start_date is YYYY-MM-DD.'),
      );
    }
    if (claim.sessions === null || !Number.isInteger(claim.sessions)) {
      return no(
        refuse(
          'sessions',
          'invalid_session_count',
          `A routine is ${MIN_SESSIONS} to ${MAX_SESSIONS} sessions.`,
        ),
      );
    }
    count = claim.sessions;
    first = claim.startDate;
    if (!inBookingRange(first, today)) {
      return no(
        refuse(
          'start_date',
          'date_out_of_range',
          `The first session must be from today to ${BOOKING_HORIZON_DAYS} days ahead.`,
        ),
      );
    }
  }

  if (count < MIN_SESSIONS || count > MAX_SESSIONS) {
    return no(
      refuse(
        frequency === 'CUSTOM' ? 'dates' : 'sessions',
        'invalid_session_count',
        `A routine is ${MIN_SESSIONS} to ${MAX_SESSIONS} sessions.`,
      ),
    );
  }

  // ---- the time
  let startMin: number | null = null;
  if (claim.time === null) {
    if (!claim.dryRun) {
      return no(
        refuse(
          'time',
          'time_required',
          'Pick a time. Run with dry_run and no time to see the free ones.',
        ),
      );
    }
  } else {
    startMin = parseRoutineTime(claim.time);
    if (startMin === null) {
      return no(refuse('time', 'invalid_time', TIME_MESSAGE));
    }
  }

  // ---- the plan
  if (!(PAYMENT_PLANS as readonly string[]).includes(claim.paymentPlan)) {
    return no(
      refuse(
        'payment_plan',
        'invalid_payment_plan',
        'payment_plan must be PAY_AT_SALON, PAY_AS_YOU_GO or UPFRONT.',
      ),
    );
  }
  const paymentPlan = claim.paymentPlan as PaymentPlan;
  if (!claim.dryRun && !V1_PAYMENT_PLANS.includes(paymentPlan)) {
    // D2. The figures are shown on dry_run so the app can draw the three
    // cards; only paying at the salon can be booked until payments exist.
    return no(
      refuse(
        'payment_plan',
        'payment_plan_not_available',
        'Only PAY_AT_SALON can be booked for now.',
      ),
    );
  }

  // ---- the picks (D4)
  const picks: CheckedPick[] = [];
  const seen = new Set<number>();
  for (const [i, p] of claim.picks.entries()) {
    const field = `picks[${i}]`;
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= count) {
      return no(
        refuse(
          `${field}.index`,
          'invalid_pick',
          `index is a session number from 0 to ${count - 1}.`,
        ),
      );
    }
    if (seen.has(p.index)) {
      return no(
        refuse(`${field}.index`, 'invalid_pick', 'Pick once per session.'),
      );
    }
    seen.add(p.index);
    if (!isTradingDay(p.date) || !inBookingRange(p.date, today)) {
      return no(
        refuse(
          `${field}.date`,
          'invalid_pick',
          `A pick is a day from today to ${BOOKING_HORIZON_DAYS} days ahead.`,
        ),
      );
    }
    const pickMin = parseRoutineTime(p.time);
    if (pickMin === null) {
      return no(refuse(`${field}.time`, 'invalid_pick', TIME_MESSAGE));
    }
    picks.push({
      index: p.index,
      day: p.date,
      startMin: pickMin,
      stylistId:
        p.stylistId === null || p.stylistId.trim() === '' ? null : p.stylistId,
    });
  }

  return ok({
    dryRun: claim.dryRun,
    frequency,
    count,
    first,
    days,
    startMin,
    paymentPlan,
    picks,
  });
}

// ------------------------------------------------------------ money

/** The figures the app showed for the chosen plan (decimal AED). */
export interface RoutineMoneyClaims {
  readonly amountWithoutTax: number;
  readonly taxAmount: number;
  readonly discount: number;
  readonly total: number;
}

/**
 * The app's figures against the server's, figure by figure, for the whole
 * routine under its plan. Reported with the right number, as the single
 * create does: on a mismatch the app shows what changed.
 */
export function checkRoutineMoney(
  claims: RoutineMoneyClaims,
  expected: PlanMoney,
): SeriesRefusal | null {
  const checks: readonly [string, number, number][] = [
    ['amount_without_tax', claims.amountWithoutTax, expected.subtotalFils],
    ['tax_amount', claims.taxAmount, expected.vatFils],
    ['discount', claims.discount, expected.discountFils],
    ['total', claims.total, expected.totalFils],
  ];
  for (const [field, claimed, want] of checks) {
    const fils = aedToFils(claimed);
    if (fils === null || !amountsAgree(want, fils)) {
      return {
        field,
        code: 'amount_mismatch',
        message: 'Prices changed since this routine was started.',
        expected: filsToAed(want),
      };
    }
  }
  return null;
}

// ------------------------------------------------------------ PATCH

/** PATCH /v1/mobile-booking/series/:id, as the app sent it. */
export interface ManageClaim {
  readonly action: string;
  readonly dryRun: boolean;
  /** SKIP. */
  readonly sessionIds: readonly string[] | null;
  /** RESCHEDULE. */
  readonly sessionId: string | null;
  readonly date: string | null;
  readonly time: string | null;
  readonly stylistId: string | null;
  /** EXTEND: how many (not CUSTOM), or the days (CUSTOM). */
  readonly sessions: number | null;
  readonly dates: readonly string[] | null;
  /** PAUSE. */
  readonly until: string | null;
  readonly reason: string | null;
  readonly note: string | null;
}

export type CheckedManage =
  | { readonly action: 'SKIP'; readonly sessionIds: readonly string[] }
  | {
      readonly action: 'RESCHEDULE';
      readonly sessionId: string;
      readonly day: TradingDay;
      readonly startMin: number;
      readonly stylistId: string | null;
    }
  | {
      readonly action: 'EXTEND';
      readonly count: number;
      /** CUSTOM only. */
      readonly days: readonly TradingDay[] | null;
    }
  | {
      readonly action: 'PAUSE';
      readonly until: TradingDay;
      readonly reason: PauseReason | null;
      readonly note: string | null;
    }
  | { readonly action: 'RESUME' };

/** What a pause note may be: 1 to 200 characters, as the column's CHECK. */
export const PAUSE_NOTE_MAX = 200;

/**
 * The PATCH body on its own. `frequency` is the routine's, from its row: it
 * decides whether EXTEND takes a count or days.
 *
 * Only the shape is checked here. Whether the session is locked, the routine
 * active, the pause short enough or the extend small enough depends on the
 * rows, and is in mobile-series.ts.
 */
export function checkManage(
  claim: ManageClaim,
  frequency: Frequency,
): Checked<CheckedManage> {
  if (!(ROUTINE_ACTIONS as readonly string[]).includes(claim.action)) {
    return no(
      refuse(
        'action',
        'invalid_action',
        'action must be SKIP, RESCHEDULE, EXTEND, PAUSE or RESUME.',
      ),
    );
  }

  switch (claim.action) {
    case 'SKIP': {
      const ids = claim.sessionIds ?? [];
      if (
        ids.length === 0 ||
        ids.some((id) => id.trim() === '') ||
        new Set(ids).size !== ids.length
      ) {
        return no(
          refuse(
            'session_ids',
            'invalid_sessions',
            'Name each session to skip once.',
          ),
        );
      }
      return ok({ action: 'SKIP', sessionIds: ids });
    }

    case 'RESCHEDULE': {
      if ((claim.sessionId ?? '').trim() === '') {
        return no(
          refuse('session_id', 'invalid_sessions', 'Name the session to move.'),
        );
      }
      if (claim.date === null || !isTradingDay(claim.date)) {
        return no(refuse('date', 'invalid_date', 'date is YYYY-MM-DD.'));
      }
      const startMin =
        claim.time === null ? null : parseRoutineTime(claim.time);
      if (startMin === null) {
        return no(refuse('time', 'invalid_time', TIME_MESSAGE));
      }
      return ok({
        action: 'RESCHEDULE',
        sessionId: claim.sessionId!,
        day: claim.date,
        startMin,
        stylistId:
          claim.stylistId === null || claim.stylistId.trim() === ''
            ? null
            : claim.stylistId,
      });
    }

    case 'EXTEND': {
      if (frequency === 'CUSTOM') {
        const dates = claim.dates ?? [];
        if (claim.dates === null || claim.sessions !== null) {
          return no(
            refuse(
              'dates',
              'invalid_extend',
              'A CUSTOM routine is extended with dates, not a number of sessions.',
            ),
          );
        }
        if (dates.length < EXTEND_MIN || dates.length > EXTEND_MAX) {
          return no(
            refuse(
              'dates',
              'invalid_extend',
              `Add ${EXTEND_MIN} to ${EXTEND_MAX} sessions.`,
            ),
          );
        }
        const at = dates.findIndex((d) => !isTradingDay(d));
        if (at !== -1) {
          return no(
            refuse(`dates[${at}]`, 'invalid_date', 'A date is YYYY-MM-DD.'),
          );
        }
        if (new Set(dates).size !== dates.length) {
          return no(refuse('dates', 'invalid_date', 'Pick each day once.'));
        }
        return ok({
          action: 'EXTEND',
          count: dates.length,
          days: [...dates].sort(),
        });
      }
      if (claim.dates !== null || claim.sessions === null) {
        return no(
          refuse(
            'sessions',
            'invalid_extend',
            'Send how many sessions to add. Only a CUSTOM routine sends dates.',
          ),
        );
      }
      // The range (1 to 6, and 6 still to come at most) is checkExtend's,
      // because the second half needs the rows.
      return ok({ action: 'EXTEND', count: claim.sessions, days: null });
    }

    case 'PAUSE': {
      if (claim.until === null || !isTradingDay(claim.until)) {
        return no(
          refuse(
            'until',
            'invalid_pause',
            'until is the resume date, YYYY-MM-DD.',
          ),
        );
      }
      let reason: PauseReason | null = null;
      if (claim.reason !== null) {
        if (!(PAUSE_REASONS as readonly string[]).includes(claim.reason)) {
          return no(
            refuse(
              'reason',
              'invalid_pause_reason',
              'reason must be TRAVEL, HEALTH, BUDGET or OTHER.',
            ),
          );
        }
        reason = claim.reason as PauseReason;
      }
      const note = (claim.note ?? '').trim();
      if (note.length > PAUSE_NOTE_MAX) {
        return no(
          refuse(
            'note',
            'invalid_pause',
            `A note is at most ${PAUSE_NOTE_MAX} characters.`,
          ),
        );
      }
      return ok({
        action: 'PAUSE',
        until: claim.until,
        reason,
        note: note === '' ? null : note,
      });
    }

    default:
      return ok({ action: 'RESUME' });
  }
}
