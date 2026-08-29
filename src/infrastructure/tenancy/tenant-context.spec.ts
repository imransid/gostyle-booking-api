import { describe, it, expect } from 'vitest';
import {
  TenantContext,
  readTenantHeader,
  MAX_TENANT_ID_LENGTH,
} from './tenant-context';

describe('reading the header', () => {
  it('takes a plain value', () => {
    expect(readTenantHeader('tenant-alpha')).toBe('tenant-alpha');
  });

  it('trims surrounding whitespace', () => {
    expect(readTenantHeader('  tenant-alpha \n')).toBe('tenant-alpha');
  });

  it('treats an empty or blank header as no tenant', () => {
    // One representation of "no tenant", not two. NULL is the other.
    expect(readTenantHeader('')).toBeNull();
    expect(readTenantHeader('   ')).toBeNull();
  });

  it('ignores a header that is not a string', () => {
    // Express hands back string[] for a repeated header.
    expect(readTenantHeader(['a', 'b'])).toBeNull();
    expect(readTenantHeader(undefined)).toBeNull();
  });

  it('refuses a value longer than the column allows', () => {
    const ok = 'x'.repeat(MAX_TENANT_ID_LENGTH);
    const tooLong = 'x'.repeat(MAX_TENANT_ID_LENGTH + 1);
    expect(readTenantHeader(ok)).toBe(ok);
    // Rejected here rather than by the CHECK: a 500 from a constraint is a
    // worse answer than ignoring a header nobody should have sent.
    expect(readTenantHeader(tooLong)).toBeNull();
  });
});

describe('the request scope', () => {
  it('is null outside any request', () => {
    expect(new TenantContext().current()).toBeNull();
  });

  it('carries the tenant through the callback', () => {
    const ctx = new TenantContext();
    ctx.run('tenant-alpha', () => {
      expect(ctx.current()).toBe('tenant-alpha');
    });
  });

  it('survives an await, which is the whole point', async () => {
    const ctx = new TenantContext();
    await ctx.run('tenant-alpha', async () => {
      await Promise.resolve();
      expect(ctx.current()).toBe('tenant-alpha');
    });
  });

  it('does not leak out of the request', () => {
    const ctx = new TenantContext();
    ctx.run('tenant-alpha', () => ctx.current());
    expect(ctx.current()).toBeNull();
  });

  it('keeps two concurrent requests apart', async () => {
    const ctx = new TenantContext();
    const seen: string[] = [];
    await Promise.all([
      ctx.run('alpha', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(ctx.current() ?? 'null');
      }),
      ctx.run('beta', async () => {
        seen.push(ctx.current() ?? 'null');
      }),
    ]);
    expect(seen.sort()).toEqual(['alpha', 'beta']);
  });

  it('a request with no tenant reads null, not the previous one', () => {
    const ctx = new TenantContext();
    ctx.run('alpha', () => ctx.current());
    ctx.run(null, () => {
      expect(ctx.current()).toBeNull();
    });
  });
});
