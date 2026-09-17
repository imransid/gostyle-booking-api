/**
 * The arithmetic behind the seven booking screens.
 *
 * These are read-model rules, and they are here rather than in a query
 * handler for the usual reason: they are the part that can be WRONG in a way
 * a human notices. A utilisation figure measured against the wrong
 * denominator makes a short Thursday look like an idle day, and a delta
 * string with the sign flipped tells the owner revenue fell when it rose.
 *
 * Nothing here touches Prisma, Nest or a Date. Minutes and integers in,
 * numbers and strings out.
 */

import { Money } from '../shared/money';

// ------------------------------------------------------------ utilisation

/**
 * A professional's sellable minutes for one day.
 *
 * SELLABLE, NOT TRADING. The denominator is the published shift minus
 * approved time off, never the branch's opening hours. A stylist rostered
 * 10:00-14:00 on a quiet Thursday is fully booked at four hours; measured
 * against a twelve-hour trading window she reads as 33% and the owner goes
 * looking for a problem that is not there.
 *
 * Time off is subtracted only where it OVERLAPS the shift. Approved leave
 * that sits outside the roster is not capacity anybody lost.
 */
export interface SellableInput {
  readonly shift: { readonly fromMin: number; readonly toMin: number };
  readonly timeOff: readonly {
    readonly fromMin: number;
    readonly toMin: number;
  }[];
}

export function sellableMinutes(input: SellableInput): number {
  const shiftMin = Math.max(0, input.shift.toMin - input.shift.fromMin);
  if (shiftMin === 0) return 0;

  const off = mergeSpans(
    input.timeOff
      .map((t) => ({
        fromMin: Math.max(t.fromMin, input.shift.fromMin),
        toMin: Math.min(t.toMin, input.shift.toMin),
      }))
      .filter((t) => t.toMin > t.fromMin),
  );

  const offMin = off.reduce((n, t) => n + (t.toMin - t.fromMin), 0);
  return Math.max(0, shiftMin - offMin);
}

/**
 * Overlapping spans merged, so two half-day leave rows covering the same
 * afternoon are not subtracted twice. A double-subtraction here produces a
 * utilisation above 100%, which is the kind of number nobody believes and
 * everybody then ignores.
 */
export function mergeSpans(
  spans: readonly { readonly fromMin: number; readonly toMin: number }[],
): { fromMin: number; toMin: number }[] {
  const sorted = [...spans].sort((a, b) => a.fromMin - b.fromMin);
  const out: { fromMin: number; toMin: number }[] = [];

  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.fromMin <= last.toMin) {
      last.toMin = Math.max(last.toMin, s.toMin);
    } else {
      out.push({ fromMin: s.fromMin, toMin: s.toMin });
    }
  }
  return out;
}

/**
 * Booked over sellable, in [0, 1].
 *
 * Zero sellable minutes returns 0, not NaN and not a division by zero. A day
 * nobody was rostered for is 0% utilised, which is both true and renderable.
 * It is the single most likely input on a Sunday.
 */
export function utilisation(bookedMin: number, sellableMin: number): number {
  if (sellableMin <= 0) return 0;
  return clamp01(bookedMin / sellableMin);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ------------------------------------------------------------ deltas

/**
 * The comparison string on a KPI tile.
 *
 * THE SERVER RENDERS IT, because the client must not be the authority on a
 * number (their rule 1) and because the three kinds of delta read
 * differently: a count moves by a percentage, a rate moves by points, and an
 * average moves by an absolute amount.
 *
 * The minus sign is U+2212 MINUS SIGN, not a hyphen. A hyphen next to a digit
 * renders a hair short in most UI fonts and looks like a typo at tile size.
 */
export const MINUS = '−';

export type DeltaKind = 'percent' | 'points' | 'absolute';

/**
 * Two windows of equal length, compared.
 *
 * A PRIOR OF ZERO HAS NO PERCENTAGE. Dividing by it gives Infinity, and
 * "+Infinity%" on a dashboard is worse than saying nothing. So a rise from
 * nothing reports as "new" and an unchanged nothing reports as flat.
 */
export function formatDelta(
  current: number,
  prior: number,
  kind: DeltaKind = 'percent',
): string {
  if (kind === 'points') {
    // Rates arrive as fractions (0.94), and the tile speaks points.
    const pts = Math.round((current - prior) * 100);
    return pts === 0 ? '0 pts' : `${sign(pts)}${Math.abs(pts)} pts`;
  }

  if (kind === 'absolute') {
    const d = Math.round(current - prior);
    return d === 0 ? '0' : `${sign(d)}${Math.abs(d)}`;
  }

  if (prior === 0) return current === 0 ? '0%' : 'new';

  const pct = Math.round(((current - prior) / prior) * 100);
  return pct === 0 ? '0%' : `${sign(pct)}${Math.abs(pct)}%`;
}

function sign(n: number): string {
  return n > 0 ? '+' : MINUS;
}

/** A KPI tile: the value, and how it compares with the window before it. */
export interface Kpi {
  readonly value: number;
  readonly delta: string;
}

export function kpi(
  current: number,
  prior: number,
  kind: DeltaKind = 'percent',
): Kpi {
  return { value: current, delta: formatDelta(current, prior, kind) };
}

/**
 * Money KPIs are built from fils and published in whole AED.
 *
 * The DELTA is computed on the fils, before rounding. Rounding both sides
 * first and subtracting can move the answer by a full dirham on a small
 * base, and the tile then disagrees with the figure beside it.
 */
export function moneyKpi(currentFils: number, priorFils: number): Kpi {
  return {
    value: wholeAed(currentFils),
    delta: formatDelta(currentFils, priorFils, 'percent'),
  };
}

/**
 * Fils to whole AED, for the screens that publish a `number` rather than
 * minor units. Money.fils() is the gate: a fractional fil throws here rather
 * than becoming a rounding error three screens later.
 */
export function wholeAed(fils: number): number {
  return Math.round(Money.fils(fils).fils / 100);
}

// ------------------------------------------------------------ show-up rate

/**
 * Of the visits that reached a conclusion, how many were kept.
 *
 * THE DENOMINATOR IS DELIBERATELY NOT "every booking". A day full of
 * confirmed bookings that have not happened yet would otherwise drag the
 * rate towards zero and make every morning look like a disaster. Only
 * settled, completed, no-showed and cancelled visits have an answer.
 *
 * No concluded visits at all returns 1, not 0: a branch that has not opened
 * has not failed to show anybody up, and 0% on the tile would start a
 * conversation about a problem that does not exist.
 */
export function showUpRate(input: {
  readonly kept: number;
  readonly noShows: number;
  readonly lateCancels: number;
}): number {
  const concluded = input.kept + input.noShows + input.lateCancels;
  if (concluded === 0) return 1;
  return clamp01(input.kept / concluded);
}

// ------------------------------------------------------------ search

export type SearchKind = 'BOOKING' | 'CUSTOMER' | 'SERVICE' | 'SERIES';

export interface SearchCandidate {
  readonly kind: SearchKind;
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** The booking code, where the row has one. Matched exactly, case-free. */
  readonly code?: string | undefined;
  /** Everything else worth matching: name, phone, service name. */
  readonly haystack: readonly string[];
}

/**
 * Command-palette ranking.
 *
 * "Rank exact code matches first" is the contract's one hard requirement, and
 * it is the one that matters: a desk agent who types GS-1041 wants that
 * booking, not a customer whose phone number happens to contain 1041.
 *
 * The rest is least-astonishing: a prefix beats a substring, a shorter label
 * beats a longer one at equal quality, and ties break on the label so the
 * list does not reshuffle between identical queries.
 */
export const MIN_NUMERIC_QUERY = 3;

export function rankSearch(
  candidates: readonly SearchCandidate[],
  query: string,
  limit = 10,
): SearchCandidate[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  // A ONE- OR TWO-DIGIT QUERY MATCHES NOTHING, and that is the useful answer.
  // "55" appears in most UAE mobile numbers and in a third of the prices, so
  // matching it returns the whole branch ranked by accident. A desk agent
  // typing two digits has not finished typing.
  if (/^\d+$/.test(q) && q.length < MIN_NUMERIC_QUERY) return [];

  const scored = candidates
    .map((c) => ({ c, score: scoreOf(c, q) }))
    .filter((x) => x.score > 0);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.c.label.length - b.c.label.length ||
      (a.c.label < b.c.label ? -1 : a.c.label > b.c.label ? 1 : 0),
  );

  return scored.slice(0, Math.max(0, limit)).map((x) => x.c);
}

function scoreOf(c: SearchCandidate, q: string): number {
  if (c.code !== undefined && c.code.toLowerCase() === q) return 1000;
  if (c.code !== undefined && c.code.toLowerCase().includes(q)) return 500;

  let best = 0;
  for (const raw of c.haystack) {
    const h = raw.toLowerCase();
    if (h === q) best = Math.max(best, 400);
    else if (h.startsWith(q)) best = Math.max(best, 300);
    else if (h.includes(q)) best = Math.max(best, 100);
    // A phone typed with spaces or a +971 prefix should still find the row.
    else if (
      digitsOnly(q).length >= MIN_NUMERIC_QUERY &&
      digitsOnly(h) !== '' &&
      digitsOnly(h).includes(digitsOnly(q))
    ) {
      best = Math.max(best, 200);
    }
  }
  return best;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}
