import { describe, expect, it } from 'vitest';
import { resolveBranchScope, sameBranch } from './branch-scope';

const FALLBACK = 'marina-walk';
const OURS = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';

describe('resolveBranchScope', () => {
  it('uses the token branch when one is on the token', () => {
    const v = resolveBranchScope({
      header: null,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v).toEqual({ kind: 'resolved', branchId: OURS, from: 'token' });
  });

  it('is the whole bug: a read with no parameter lands on the token branch, not the demo one', () => {
    // GET /v1/bookings/waitlist has no branchId to send. Before this rule it
    // fell to DEFAULT_BRANCH_ID and could never see a row written elsewhere.
    const read = resolveBranchScope({
      header: null,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    const write = resolveBranchScope({
      header: null,
      requested: OURS,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(read.kind).toBe('resolved');
    expect(write.kind).toBe('resolved');
    expect((read as { branchId: string }).branchId).toBe(
      (write as { branchId: string }).branchId,
    );
  });

  it('accepts a request that names the token branch', () => {
    const v = resolveBranchScope({
      header: null,
      requested: OURS,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v.kind).toBe('resolved');
  });

  it('refuses a request that names a different branch than the token', () => {
    const v = resolveBranchScope({
      header: null,
      requested: FALLBACK,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v).toEqual({
      kind: 'mismatch',
      tokenBranchId: OURS,
      requested: FALLBACK,
    });
  });

  it('catches the disagreement in the header too, not only the body', () => {
    const v = resolveBranchScope({
      header: FALLBACK,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v.kind).toBe('mismatch');
  });

  it('catches a body that disagrees while the header agrees', () => {
    // A client cannot scope with the header and smuggle another branch below.
    const v = resolveBranchScope({
      header: OURS,
      requested: FALLBACK,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v.kind).toBe('mismatch');
  });

  it('treats case and whitespace as the same branch', () => {
    const v = resolveBranchScope({
      header: null,
      requested: `  ${OURS.toUpperCase()} `,
      tokenBranchId: OURS,
      fallback: FALLBACK,
    });
    expect(v.kind).toBe('resolved');
  });

  it('lets a token with no branch name one -- a customer, or a company owner', () => {
    const v = resolveBranchScope({
      header: null,
      requested: OURS,
      tokenBranchId: null,
      fallback: FALLBACK,
    });
    expect(v).toEqual({ kind: 'resolved', branchId: OURS, from: 'request' });
  });

  it('prefers the header over the body when the token names no branch', () => {
    const v = resolveBranchScope({
      header: 'from-header',
      requested: 'from-body',
      tokenBranchId: null,
      fallback: FALLBACK,
    });
    expect(v).toEqual({
      kind: 'resolved',
      branchId: 'from-header',
      from: 'header',
    });
  });

  it('falls back only when nothing said anything', () => {
    const v = resolveBranchScope({ header: null, fallback: FALLBACK });
    expect(v).toEqual({
      kind: 'resolved',
      branchId: FALLBACK,
      from: 'default',
    });
  });

  it('treats blank and whitespace as absent, never as a branch', () => {
    const v = resolveBranchScope({
      header: '   ',
      requested: '',
      tokenBranchId: null,
      fallback: FALLBACK,
    });
    expect(v).toEqual({
      kind: 'resolved',
      branchId: FALLBACK,
      from: 'default',
    });
  });
});

describe('sameBranch', () => {
  it('ignores case and padding', () => {
    expect(sameBranch(' Marina-Walk ', 'marina-walk')).toBe(true);
  });
  it('does not confuse two branches', () => {
    expect(sameBranch(OURS, FALLBACK)).toBe(false);
  });
});
