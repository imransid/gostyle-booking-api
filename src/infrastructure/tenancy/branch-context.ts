import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which branch the current request is about.
 *
 * WHY THIS EXISTS. Availability, capacity, pricing and policy are all per
 * branch, and until now the branch arrived as a `branchId` field in the body
 * or the query, defaulting to 'marina-walk' on several routes. The front-end
 * contract requires an `X-Branch-Id` header on every route, and a header that
 * is read by nothing FAILS OPEN: a caller that carefully scopes every request
 * to branch B gets branch A's diary and no warning.
 *
 * So the header is read here, first, and wins.
 *
 * THE FALLBACK CHAIN, highest precedence first:
 *
 *   1. X-Branch-Id                 the contract's answer
 *   2. an explicit branchId in the body or query
 *   3. DEFAULT_BRANCH_ID           what every route did before this existed
 *
 * Rung 3 is what makes this change additive: no existing caller breaks, and a
 * caller that adopts the header immediately gets the scoping it asked for.
 *
 * MAKING IT MANDATORY is one environment variable — see `branchRequired()`.
 * That switch is deliberately not thrown here: rejecting every unheadered
 * request the day this ships would take the desk down, and "fail closed"
 * means closed against *wrong* data, not closed against a rollout.
 */
@Injectable()
export class BranchContext {
  private readonly store = new AsyncLocalStorage<string | null>();

  run<T>(branchId: string | null, fn: () => T): T {
    return this.store.run(branchId, fn);
  }

  /** The header value for this request, or null if none was sent. */
  current(): string | null {
    return this.store.getStore() ?? null;
  }
}

export const BRANCH_HEADER = 'x-branch-id';

export const MAX_BRANCH_ID_LENGTH = 64;

/** What every route defaulted to before the header existed. */
export const DEFAULT_BRANCH_ID = 'marina-walk';

/**
 * Bounded and trimmed at the edge, like the tenant header.
 *
 * An over-long or blank value is treated as absent rather than rejected: it
 * then falls through to the body, which is the behaviour that existed before,
 * and a malformed header cannot 500 a request that would otherwise have
 * worked.
 */
export function readBranchHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_BRANCH_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Is the header mandatory?
 *
 * Off by default. Set REQUIRE_BRANCH_HEADER=true once the front end sends it
 * everywhere, and an unheadered request is refused instead of defaulted.
 */
export function branchRequired(
  raw = process.env.REQUIRE_BRANCH_HEADER,
): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * The precedence chain, in one place so no controller re-implements it.
 *
 * `fromBody` is whatever the DTO carried. It is IGNORED when a header is
 * present, so a client that sends both cannot have the two disagree and get
 * the body's answer — the header is the scoping the platform controls.
 */
export function resolveBranch(input: {
  readonly header: string | null;
  readonly fromBody?: string | undefined;
}): string {
  if (input.header !== null) return input.header;
  const body = (input.fromBody ?? '').trim();
  if (body !== '') return body;
  return DEFAULT_BRANCH_ID;
}
