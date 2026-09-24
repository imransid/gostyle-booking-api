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
        // Yields once, so beta genuinely interleaves with alpha's timer
        // rather than running to completion before it starts.
        await Promise.resolve();
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

describe('filling from the token', () => {
  it('fills the tenant when the header gave none', () => {
    const ctx = new TenantContext();
    ctx.run(null, () => {
      ctx.fillFromToken('tenant-from-token');
      expect(ctx.current()).toBe('tenant-from-token');
    });
  });

  it('never overrides a header that is present', () => {
    // A fallback, not an override: the header already answered.
    const ctx = new TenantContext();
    ctx.run('tenant-from-header', () => {
      ctx.fillFromToken('tenant-from-token');
      expect(ctx.current()).toBe('tenant-from-header');
    });
  });

  it('leaves a customer token, which carries no tenant, with none', () => {
    const ctx = new TenantContext();
    ctx.run(null, () => {
      ctx.fillFromToken(null);
      expect(ctx.current()).toBeNull();
      ctx.fillFromToken(undefined);
      expect(ctx.current()).toBeNull();
    });
  });

  it('bounds the claim exactly as it bounds the header', () => {
    const ctx = new TenantContext();
    ctx.run(null, () => {
      ctx.fillFromToken('   ');
      expect(ctx.current()).toBeNull();
      ctx.fillFromToken('x'.repeat(MAX_TENANT_ID_LENGTH + 1));
      expect(ctx.current()).toBeNull();
      ctx.fillFromToken('  tenant-alpha ');
      expect(ctx.current()).toBe('tenant-alpha');
    });
  });

  it('does nothing outside a request scope', () => {
    const ctx = new TenantContext();
    ctx.fillFromToken('tenant-alpha');
    expect(ctx.current()).toBeNull();
  });

  it('survives an await after it was filled', async () => {
    const ctx = new TenantContext();
    await ctx.run(null, async () => {
      ctx.fillFromToken('tenant-alpha');
      await Promise.resolve();
      expect(ctx.current()).toBe('tenant-alpha');
    });
  });

  it('keeps two requests in flight apart, filled or not', async () => {
    // The slot is mutable, so this is the test that matters: every run()
    // must get its OWN slot, or one request's token fills another's tenant.
    // Each request fills, yields, and reads back after the other has filled.
    const ctx = new TenantContext();
    const seen: Record<string, string | null> = {};
    let alphaFilled!: () => void;
    const alphaHasFilled = new Promise<void>((r) => (alphaFilled = r));

    await Promise.all([
      ctx.run(null, async () => {
        ctx.fillFromToken('alpha');
        alphaFilled();
        await new Promise((r) => setTimeout(r, 5));
        seen.alpha = ctx.current();
      }),
      ctx.run(null, async () => {
        // Starts only once alpha's slot holds 'alpha', so a shared slot
        // would hand 'alpha' to beta here and refuse beta's own fill.
        await alphaHasFilled;
        expect(ctx.current()).toBeNull();
        ctx.fillFromToken('beta');
        seen.beta = ctx.current();
      }),
      ctx.run('gamma-header', async () => {
        await alphaHasFilled;
        ctx.fillFromToken('gamma-token');
        await new Promise((r) => setTimeout(r, 1));
        seen.gamma = ctx.current();
      }),
      ctx.run(null, async () => {
        // A customer in flight beside them: nothing to fill, and nothing
        // borrowed from the requests around it.
        await alphaHasFilled;
        ctx.fillFromToken(null);
        await new Promise((r) => setTimeout(r, 2));
        seen.customer = ctx.current();
      }),
    ]);

    expect(seen).toEqual({
      alpha: 'alpha',
      beta: 'beta',
      gamma: 'gamma-header',
      customer: null,
    });
    expect(ctx.current()).toBeNull();
  });

  it('a nested scope opened after a fill does not write back into it', () => {
    // mobile-booking.handler runs a nested scope for a booking's own tenant.
    const ctx = new TenantContext();
    ctx.run(null, () => {
      ctx.fillFromToken('outer');
      ctx.run(null, () => {
        ctx.fillFromToken('inner');
        expect(ctx.current()).toBe('inner');
      });
      expect(ctx.current()).toBe('outer');
    });
  });
});
