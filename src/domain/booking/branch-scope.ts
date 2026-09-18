/**
 * WHICH BRANCH A REQUEST IS ABOUT. One rule, one place.
 *
 * THE BUG THIS CLOSES. The service resolved a branch two ways and they did
 * not agree. A route that took `branchId` in the body used it literally; a
 * route that took none fell back to DEFAULT_BRANCH_ID. So a waitlist entry
 * joined with `branchId: "b7e92439-…"` was written to that branch, and
 * `GET /v1/bookings/waitlist` -- which had no parameter to read -- looked in
 * `marina-walk` and found nothing. The row was real, accepted, and invisible
 * forever. The same shape hid a series from its own board.
 *
 * THE TOKEN OUTRANKS THE BODY, because the token is the only part of the
 * request the caller cannot choose. A staff token carries the branch its
 * holder works at; a body field is whatever the client happened to send. If
 * both are present and they DISAGREE, that is not a precedence question --
 * it is a caller writing into somebody else's diary, and it is refused
 * rather than silently resolved in either direction.
 *
 * A NULL TOKEN BRANCH IS NOT A MISMATCH. A customer token carries none, and
 * neither does a company owner's: "all branches" is a real answer and those
 * callers must still be able to name one. So the chain below only fires its
 * guard when the token actually names a branch.
 *
 * The comparison is case-insensitive and trimmed. A uuid that differs only
 * in case is the same branch, and refusing it would be a 403 for a spelling.
 */

export type BranchScope =
  /** Use this branch. */
  | {
      readonly kind: 'resolved';
      readonly branchId: string;
      readonly from: BranchSource;
    }
  /** The request named a branch its token does not cover. */
  | {
      readonly kind: 'mismatch';
      readonly tokenBranchId: string;
      readonly requested: string;
    };

/** Which rung answered. Published on /settings so a client can see it. */
export type BranchSource = 'token' | 'header' | 'request' | 'default';

export interface BranchScopeInput {
  /** X-Branch-Id, or null when none was sent. */
  readonly header: string | null;
  /** `branchId` from the body or the query string, if any. */
  readonly requested?: string | null | undefined;
  /** The branch claim on the verified token. Null means "all branches". */
  readonly tokenBranchId?: string | null | undefined;
  /** What every route did before any of this existed. */
  readonly fallback: string;
}

export function resolveBranchScope(input: BranchScopeInput): BranchScope {
  const token = clean(input.tokenBranchId);
  const header = clean(input.header);
  const requested = clean(input.requested);

  if (token !== null) {
    // Both the header and the body are checked, and either one disagreeing is
    // enough. Checking only the one that "wins" would let a client scope a
    // request with a header and smuggle a different branch in the body.
    for (const named of [header, requested]) {
      if (named !== null && !sameBranch(named, token)) {
        return { kind: 'mismatch', tokenBranchId: token, requested: named };
      }
    }
    return { kind: 'resolved', branchId: token, from: 'token' };
  }

  if (header !== null) {
    return { kind: 'resolved', branchId: header, from: 'header' };
  }
  if (requested !== null) {
    return { kind: 'resolved', branchId: requested, from: 'request' };
  }
  return { kind: 'resolved', branchId: input.fallback, from: 'default' };
}

/** Same branch, allowing for case and stray whitespace. */
export function sameBranch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function clean(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
