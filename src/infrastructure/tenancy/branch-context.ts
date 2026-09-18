import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bookingError } from '@application/contract/errors';
import {
  resolveBranchScope,
  type BranchSource,
} from '@domain/booking/branch-scope';

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
 * THE TOKEN NOW OUTRANKS BOTH. That is the fix for the worst bug the front
 * end found: routes that took a `branchId` used it literally, routes that
 * took none fell to DEFAULT_BRANCH_ID, and the two did not agree. A waitlist
 * entry joined with our branch id was WRITTEN to our branch and the board --
 * which has no parameter to send -- looked in the demo branch and found
 * nothing. Accepted, real, and invisible forever. Same shape hid a series
 * from its own board.
 *
 * THE FALLBACK CHAIN, highest precedence first:
 *
 *   1. the branch claim on the verified token   the only rung a caller
 *                                               cannot choose
 *   2. X-Branch-Id                              the contract's answer
 *   3. an explicit branchId in the body/query
 *   4. DEFAULT_BRANCH_ID                        what every route did before
 *
 * Rungs 2-4 are unchanged, so a customer token (which carries no branch) and
 * every existing slug caller behave exactly as before. Rung 1 only fires for
 * a staff token that actually names a branch, and when it does, a request
 * naming a DIFFERENT one is refused rather than silently resolved either way
 * -- see `resolveBranchScope`, where that rule and its spec live.
 *
 * MAKING THE HEADER MANDATORY is one environment variable — see
 * `branchRequired()`. That switch is deliberately not thrown here: rejecting
 * every unheadered request the day this ships would take the desk down, and
 * "fail closed" means closed against *wrong* data, not closed against a
 * rollout.
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

export interface ResolvedBranch {
  readonly branchId: string;
  readonly source: BranchSource;
}

/**
 * The precedence chain, in one place so no controller re-implements it.
 *
 * `fromRequest` is whatever the body or the query carried. It is checked
 * AGAINST the token rather than merely outranked by it: a client that sends
 * both and disagrees is writing somewhere it cannot read back, and that is a
 * 403 with the token's branch in `details`, not a silent choice.
 */
export function resolveBranchWithSource(input: {
  readonly header: string | null;
  readonly fromRequest?: string | null | undefined;
  readonly tokenBranchId?: string | null | undefined;
}): ResolvedBranch {
  const scope = resolveBranchScope({
    header: input.header,
    requested: input.fromRequest,
    tokenBranchId: input.tokenBranchId,
    fallback: DEFAULT_BRANCH_ID,
  });

  if (scope.kind === 'mismatch') {
    throw bookingError(
      'BOOKING_BRANCH_MISMATCH',
      `This token is scoped to branch ${scope.tokenBranchId}, and the ` +
        `request named ${scope.requested}. Send no branchId, or send that ` +
        'one: a write to another branch would not be readable afterwards.',
      { branchId: scope.tokenBranchId, requested: scope.requested },
    );
  }

  return { branchId: scope.branchId, source: scope.from };
}

/** The same chain when only the id is wanted. */
export function resolveBranch(input: {
  readonly header: string | null;
  readonly fromRequest?: string | null | undefined;
  readonly tokenBranchId?: string | null | undefined;
}): string {
  return resolveBranchWithSource(input).branchId;
}

/**
 * The branch for one Express request, resolved from everything it carries.
 *
 * Reads the header, the token (which the guard has already verified onto
 * `req.actor`) and `branchId` from the body or the query string. Shared by
 * the `@BranchId()` decorator and by /settings, which publishes the answer so
 * a client can see which branch it is actually talking to.
 */
export function resolveBranchForRequest(
  req: {
    headers?: Record<string, unknown> | undefined;
    body?: unknown;
    query?: unknown;
    actor?: { branchId?: string | null } | undefined;
  },
  field = 'branchId',
): ResolvedBranch {
  return resolveBranchWithSource({
    header: readBranchHeader(req.headers?.[BRANCH_HEADER]),
    fromRequest: pick(req.body, field) ?? pick(req.query, field),
    tokenBranchId: req.actor?.branchId ?? null,
  });
}

function pick(bag: unknown, field: string): string | null {
  if (typeof bag !== 'object' || bag === null) return null;
  const value = (bag as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}
