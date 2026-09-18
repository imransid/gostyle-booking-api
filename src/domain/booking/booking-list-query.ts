/**
 * The query half of the customer booking list (booking-list.md §1, §5).
 *
 * Pure: strings in, a settled query out. Nothing here knows about HTTP,
 * Prisma or Nest, so every edge below is a test rather than a live request.
 */

/**
 * The three tabs. A CLOSED SET, because each is a different WHERE clause
 * and a free-text filter would be a place to typo a status.
 *
 * Deliberately not the `LIST_FILTERS` in application/contract/screen-view.ts.
 * That one is the STAFF list's chips (TODAY, CONFLICTS, NOT_REMINDED) and
 * shares nothing with this but a shape; folding them together would make a
 * customer tab and a desk chip impossible to change independently.
 */
export const MOBILE_LIST_FILTERS = [
  'upcoming',
  'recurring',
  'archive',
] as const;

export type MobileListFilter = (typeof MOBILE_LIST_FILTERS)[number];

/**
 * §1: absent means `upcoming`. Anything else is refused rather than
 * silently defaulted -- a typo'd tab returning the upcoming list looks
 * like it worked, and the app ships with a filter that never applied.
 */
export function parseFilter(raw: string | undefined): MobileListFilter | null {
  if (raw === undefined || raw === '') return 'upcoming';
  return (MOBILE_LIST_FILTERS as readonly string[]).includes(raw)
    ? (raw as MobileListFilter)
    : null;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface Paging {
  /** 1-based, as the contract states. */
  readonly page: number;
  readonly pageSize: number;
  /** For the query. Derived here so no caller does the arithmetic twice. */
  readonly skip: number;
  readonly take: number;
}

/**
 * §1's paging, clamped.
 *
 * A BAD NUMBER IS CLAMPED, NOT REFUSED, and that is a deliberate reading of
 * §5: the only listed 422 is `invalid_filter`, and a page past the end is
 * specified as an empty 200 rather than an error. So `page=0`, `page=-3`
 * and `page=banana` all mean page 1, and `pageSize=5000` means 50. A list
 * screen should not be able to hard-fail on a stale query string.
 *
 * The cap is the reason this is server-side: `pageSize` is attacker-
 * controlled and every row costs a quote, so an uncapped value is a way to
 * ask this service to do unbounded work.
 */
export function parsePaging(
  rawPage: string | undefined,
  rawPageSize: string | undefined,
): Paging {
  const page = clampInt(rawPage, 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(rawPageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  // Truncate rather than round: "1.9" is page 1, not page 2.
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export interface PageLinks {
  readonly next: string | null;
  readonly previous: string | null;
}

/**
 * §3's absolute `next` / `previous`.
 *
 * Absolute because the contract says so and because the app pastes them
 * straight into a fetch; a relative path would need the client to know
 * where it got the first page from.
 *
 * `previous` is simply page - 1 whenever there is one, even when the
 * caller asked for a page past the end. Sending them to the LAST REAL page
 * instead would be friendlier and is not what a paginator does: the
 * contract promises the neighbouring page, and quietly renumbering it
 * makes "click previous twice, get the same page" possible.
 */
export function pageLinks(input: {
  readonly baseUrl: string;
  readonly filter: MobileListFilter;
  readonly paging: Paging;
  readonly count: number;
}): PageLinks {
  const pages = Math.ceil(input.count / input.paging.pageSize);
  const at = (page: number): string =>
    `${input.baseUrl}?filter=${input.filter}&page=${page}` +
    `&pageSize=${input.paging.pageSize}`;

  return {
    next: input.paging.page < pages ? at(input.paging.page + 1) : null,
    previous: input.paging.page > 1 ? at(input.paging.page - 1) : null,
  };
}
