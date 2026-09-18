/**
 * A platform stylist, as the availability engine needs them.
 *
 * WHY THIS EXISTS. `BookingContextReader.loadDay` has always answered with a
 * hard-coded roster of six slugs -- `anya`, `maya`, `reem`. The mobile app
 * picks a stylist from `GET /v1/staff-directory/stylists`, which is REAL
 * platform data over gRPC, and then sends that `staff_profile_id` back on the
 * booking. The two id spaces never met, so every booking naming a stylist was
 * refused -- and refused as "16:00 is no longer available", because a
 * professional nobody has heard of is indistinguishable, at the engine's
 * eligibility step, from one who is fully booked.
 *
 * This is the roster half of the same stage-1 migration
 * `domain/booking/service-resolution.ts` does for the catalogue, and it is
 * deliberately the same shape: platform answers for real ids, the fixture
 * still answers for slugs, and the unsafe stubs are named rather than
 * defaulted.
 *
 * PURE. Nothing here knows about gRPC, Nest or the clock. The adapter hands
 * it rows and a trading day and gets back verdicts it can log.
 */

import type { Professional } from './feasible';
import type { Shift } from './staff-mask';

/**
 * The fields of a platform stylist this decision actually reads.
 *
 * Structural, NOT `Stylist` from the application port: the domain may not
 * import from the layer above it (CLAUDE.md: the layers point one way). The
 * port's type satisfies this shape, so the adapter passes rows straight in.
 */
export interface RosterCandidate {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  /** Branch-local wall clock, "HH:MM" or "HH:MM:SS". Null when unknown. */
  readonly openingTime: string | null;
  readonly closingTime: string | null;
  /** A weekday name, or several. Free text upstream, so parsed leniently. */
  readonly offday: string | null;
}

/**
 * Why a stylist is or is not on today's roster.
 *
 * A VERDICT RATHER THAN A `Professional | null`, because the interesting
 * cases are the drops. "Platform returned eleven stylists and the engine
 * offers none of them" is a question the log has to be able to answer without
 * a debugger (CLAUDE.md 9).
 */
export type RosterVerdict =
  | {
      readonly kind: 'rostered';
      readonly professional: Professional;
      /** Whether the shift is theirs or the branch's trading window. */
      readonly shiftFrom: 'stylist' | 'branch';
    }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'off_today'; readonly weekday: string };

// ------------------------------------------------------------------ clocks

/**
 * "17:30" or "17:30:00" to minutes past branch-local midnight.
 *
 * REFUSES rather than coerces. `Date.parse` would happily read "" as NaN and
 * "9" as a year, and a shift built from either is a working window nobody
 * published. Null means "platform did not tell us", which the caller answers
 * with the branch window and a log line -- never with a silent 00:00.
 */
export function clockToMinute(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec((value ?? '').trim());
  if (m === null) return null;

  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  // 24:00 is a legal spelling of midnight at the far end of a day and the
  // only reason hours may reach 24. 24:30 is not a time.
  if (hours > 24 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * The weekday a trading day falls on, in the branch's own calendar.
 *
 * UTC arithmetic on a date-only string, deliberately: `new Date('2026-09-21')`
 * is midnight UTC, and reading `.getDay()` off it returns yesterday west of
 * Greenwich. The trading day is already branch-local -- it is not an instant
 * and must not be treated as one.
 */
export function weekdayOf(tradingDay: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDay.trim());
  if (m === null) return null;

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip, so 2026-02-30 is refused rather than rolled into March.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;

  return WEEKDAYS[date.getUTCDay()] ?? null;
}

/**
 * Which days off a stylist's `offday` names, and which words it did not.
 *
 * LENIENT ON PURPOSE, and only here. `offday` is free text upstream: it has
 * arrived as `SUNDAY`, as `Sun`, and as `Friday, Saturday`. A parser that
 * only accepted one of those would silently roster somebody on their day off,
 * which is the failure that shows up as a customer standing in an empty salon.
 *
 * Three letters is the floor. "s" is Sunday and Saturday equally, and a
 * prefix match on one letter picks whichever is listed first -- a coin toss
 * dressed as a rule. Anything unmatched comes back in `unparsed` so the
 * adapter can say so out loud instead of treating it as "no days off".
 */
export function parseOffDays(offday: string | null | undefined): {
  readonly days: readonly string[];
  readonly unparsed: readonly string[];
} {
  const days: string[] = [];
  const unparsed: string[] = [];

  for (const raw of (offday ?? '').split(/[\s,;|/]+/)) {
    const token = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (token === '') continue;

    const hit =
      token.length >= 3
        ? WEEKDAYS.find((d) => d.startsWith(token) || token.startsWith(d))
        : undefined;

    if (hit === undefined) unparsed.push(raw);
    else if (!days.includes(hit)) days.push(hit);
  }

  return { days, unparsed };
}

// ------------------------------------------------------------- the verdict

/**
 * One platform stylist, placed on a day's roster or dropped with a reason.
 *
 * THE STUBS ARE NAMED, NOT GUESSED. Platform exposes a stylist's identity and
 * their hours and nothing else the engine needs, so two fields here are
 * placeholders and each is set in the direction that costs the SALON rather
 * than the customer:
 *
 *   skills          empty. A stylist with no recorded skill fails every
 *                   fixture service's requirement and is refused by name --
 *                   "Maya does not do colour" -- which is the honest answer
 *                   while `staff_skill_assignment` and `catalog_skill` are
 *                   two vocabularies that share no rows (ask A2). It is also
 *                   why a PLATFORM service, whose own skill is blank, must
 *                   stay behind SKILLS_UNVERIFIED: blank against empty is
 *                   "no requirement", and that is the one direction where a
 *                   wrong guess puts a trainee on a balayage.
 *
 *   bookingsToday   0, so the daily cap never fires. The cap is a fairness
 *                   rule for the stylist, not a safety one for the customer,
 *                   and platform publishes no count; 0 over-offers their day
 *                   rather than refusing a booking that is genuinely fine.
 *
 * `overlapAllowed` is FALSE, which is the safe direction rather than a stub:
 * it is the permission to seat a second client inside a colour's development
 * band, and granting it to somebody we know nothing about double-books a real
 * person.
 */
export function toProfessional(
  candidate: RosterCandidate,
  branchWindow: Shift,
  tradingDay: string,
): RosterVerdict {
  if (!candidate.active) return { kind: 'inactive' };

  const weekday = weekdayOf(tradingDay);
  const { days } = parseOffDays(candidate.offday);
  if (weekday !== null && days.includes(weekday)) {
    return { kind: 'off_today', weekday };
  }

  const opens = clockToMinute(candidate.openingTime);
  const closes = clockToMinute(candidate.closingTime);

  /**
   * BOTH ENDS OR NEITHER.
   *
   * A published open with no close is not a shift, and pairing one real
   * boundary with one invented one produces a window that looks specific and
   * is half fiction. An end at or before the start is the same kind of
   * nonsense arriving as data. Either way the branch's own trading window is
   * the honest fallback, and the caller logs that it was used.
   */
  const published =
    opens !== null && closes !== null && closes > opens
      ? { startMin: opens, endMin: closes }
      : null;

  return {
    kind: 'rostered',
    shiftFrom: published === null ? 'branch' : 'stylist',
    professional: {
      id: candidate.id,
      name: candidate.name.trim() === '' ? candidate.id : candidate.name,
      skills: new Map(),
      shift: published ?? branchWindow,
      overlapAllowed: false,
      bookingsToday: 0,
    },
  };
}
