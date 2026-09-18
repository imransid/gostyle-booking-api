import { describe, expect, it } from 'vitest';
import {
  BranchContext,
  DEFAULT_BRANCH_ID,
  MAX_BRANCH_ID_LENGTH,
  branchRequired,
  readBranchHeader,
  resolveBranch,
  resolveBranchForRequest,
} from './branch-context';

describe('readBranchHeader', () => {
  it('takes a sensible value', () => {
    expect(readBranchHeader('marina-walk')).toBe('marina-walk');
  });

  it('trims', () => {
    expect(readBranchHeader('  jbr  ')).toBe('jbr');
  });

  it('treats blank, missing and non-string as absent', () => {
    expect(readBranchHeader('')).toBeNull();
    expect(readBranchHeader('   ')).toBeNull();
    expect(readBranchHeader(undefined)).toBeNull();
    expect(readBranchHeader(['a', 'b'])).toBeNull();
    expect(readBranchHeader(42)).toBeNull();
  });

  it('treats an over-long value as absent rather than truncating it', () => {
    // Truncating would silently scope the request to a DIFFERENT branch,
    // which is the one outcome worse than ignoring the header.
    expect(readBranchHeader('x'.repeat(MAX_BRANCH_ID_LENGTH))).not.toBeNull();
    expect(readBranchHeader('x'.repeat(MAX_BRANCH_ID_LENGTH + 1))).toBeNull();
  });
});

describe('resolveBranch', () => {
  it('prefers the header over the body', () => {
    expect(resolveBranch({ header: 'jbr', fromRequest: 'marina-walk' })).toBe(
      'jbr',
    );
  });

  it('falls back to the body when no header was sent', () => {
    expect(resolveBranch({ header: null, fromRequest: 'jbr' })).toBe('jbr');
  });

  it('falls back to the default when neither is present', () => {
    expect(resolveBranch({ header: null })).toBe(DEFAULT_BRANCH_ID);
    expect(resolveBranch({ header: null, fromRequest: '' })).toBe(
      DEFAULT_BRANCH_ID,
    );
    expect(resolveBranch({ header: null, fromRequest: '  ' })).toBe(
      DEFAULT_BRANCH_ID,
    );
  });

  it('never returns an empty string', () => {
    for (const fromRequest of ['', '   ', undefined]) {
      expect(
        resolveBranch({ header: null, fromRequest }).length,
      ).toBeGreaterThan(0);
    }
  });

  it('lets the token outrank everything, so a read with no parameter still lands here', () => {
    expect(resolveBranch({ header: null, tokenBranchId: 'ours' })).toBe('ours');
  });

  it('refuses a request that names a branch the token does not cover', () => {
    expect(() =>
      resolveBranch({
        header: null,
        fromRequest: 'marina-walk',
        tokenBranchId: 'ours',
      }),
    ).toThrowError(/scoped to branch ours/);
  });
});

describe('resolveBranchForRequest', () => {
  it('reads the body, the query, the header and the token off one request', () => {
    expect(
      resolveBranchForRequest({ headers: {}, body: { branchId: 'from-body' } })
        .branchId,
    ).toBe('from-body');
    expect(
      resolveBranchForRequest({
        headers: {},
        query: { branchId: 'from-query' },
      }).branchId,
    ).toBe('from-query');
    expect(
      resolveBranchForRequest({ headers: { 'x-branch-id': 'from-header' } })
        .branchId,
    ).toBe('from-header');
    expect(
      resolveBranchForRequest({
        headers: {},
        actor: { branchId: 'from-token' },
      }),
    ).toEqual({ branchId: 'from-token', source: 'token' });
  });

  it('says which rung answered, which is what /settings publishes', () => {
    expect(resolveBranchForRequest({ headers: {} })).toEqual({
      branchId: DEFAULT_BRANCH_ID,
      source: 'default',
    });
  });

  it('survives a request with no body, query, headers or actor at all', () => {
    expect(resolveBranchForRequest({}).branchId).toBe(DEFAULT_BRANCH_ID);
  });
});

describe('branchRequired', () => {
  it('is off unless explicitly turned on', () => {
    expect(branchRequired(undefined)).toBe(false);
    expect(branchRequired('')).toBe(false);
    expect(branchRequired('false')).toBe(false);
    expect(branchRequired('1')).toBe(false);
    expect(branchRequired('yes')).toBe(false);
  });

  it('is on for exactly "true", in any case, with spaces', () => {
    expect(branchRequired('true')).toBe(true);
    expect(branchRequired('TRUE')).toBe(true);
    expect(branchRequired('  True  ')).toBe(true);
  });
});

describe('BranchContext', () => {
  it('reads null outside any scope', () => {
    expect(new BranchContext().current()).toBeNull();
  });

  it('reads the branch inside the scope', () => {
    const ctx = new BranchContext();
    ctx.run('jbr', () => {
      expect(ctx.current()).toBe('jbr');
    });
  });

  it('survives an await inside the scope', async () => {
    const ctx = new BranchContext();
    await ctx.run('jbr', async () => {
      await Promise.resolve();
      expect(ctx.current()).toBe('jbr');
    });
  });

  it('does not leak out of the scope', () => {
    const ctx = new BranchContext();
    ctx.run('jbr', () => undefined);
    expect(ctx.current()).toBeNull();
  });
});
