import { describe, it, expect, beforeEach } from 'vitest';
import { StylistRepository } from './stylist.repository';
import type { PrismaService } from './prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

/**
 * REPOSITORY SPEC — proves the QUERY SHAPE, not Postgres.
 *
 * Testing that Postgres can store a row is testing Postgres. What is worth
 * testing here is the thing that silently goes wrong: a query that forgets
 * the tenant, and therefore reads or deletes another salon's data.
 *
 * The fake records every call so the assertions can look at the arguments
 * the repository built.
 *
 * EVERY QUERY-SHAPE TEST IS it.todo UNTIL THE TABLE EXISTS. The repository's
 * bodies are commented out and return null (see stylists.controller.ts), so
 * it builds no query at all. That includes two that would otherwise pass
 * while proving nothing: the tenant sweep loops over zero recorded calls, and
 * a stub that always answers null trivially "returns null when nothing
 * matches". Flip them back to `it` the day the repository is implemented.
 */

const TENANT = 'tenant-1';

const STORED = {
  id: 'id-1',
  branchId: 'marina-walk',
  label: 'hello',
  status: 'active',
  authorId: 'maya',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
};

interface Call {
  readonly op: string;
  readonly args: {
    data?: Record<string, unknown>;
    where?: Record<string, unknown>;
  };
}

class FakePrisma {
  readonly seen: Call[] = [];

  private record(op: string, args: Call['args']): void {
    this.seen.push({ op, args });
  }

  readonly stylist = {
    create: (args: Call['args']) => {
      this.record('create', args);
      return Promise.resolve({ ...STORED, ...args.data });
    },
    findMany: (args: Call['args']) => {
      this.record('findMany', args);
      return Promise.resolve([STORED]);
    },
    findFirst: (args: Call['args']): Promise<typeof STORED | null> => {
      this.record('findFirst', args);
      return Promise.resolve(STORED);
    },
    update: (args: Call['args']) => {
      this.record('update', args);
      return Promise.resolve({ ...STORED, ...args.data });
    },
    deleteMany: (args: Call['args']) => {
      this.record('deleteMany', args);
      return Promise.resolve({ count: 1 });
    },
  };
}

const tenants = { current: () => TENANT } as unknown as TenantContext;

let prisma: FakePrisma;
let repo: StylistRepository;

beforeEach(() => {
  prisma = new FakePrisma();
  repo = new StylistRepository(prisma as unknown as PrismaService, tenants);
});

describe('tenant scoping', () => {
  it.todo('stamps the tenant on every write', async () => {
    await repo.create({
      branchId: 'marina-walk',
      label: 'hello',
      authorId: 'maya',
    });
    expect(prisma.seen[0]?.args.data?.tenantId).toBe(TENANT);
  });

  it.todo('filters the list by tenant AND branch', async () => {
    await repo.listFor('marina-walk');
    expect(prisma.seen[0]?.args.where).toEqual({
      branchId: 'marina-walk',
      tenantId: TENANT,
    });
  });

  it.todo('carries the tenant on the single read', async () => {
    await repo.find('id-1');
    expect(prisma.seen[0]?.args.where?.tenantId).toBe(TENANT);
  });

  it.todo('carries the tenant on delete', async () => {
    await repo.remove('id-1');
    expect(prisma.seen[0]?.args.where).toEqual({
      id: 'id-1',
      tenantId: TENANT,
    });
  });

  it.todo(
    'every read and delete names the tenant — none may be forgotten',
    async () => {
      await repo.listFor('marina-walk');
      await repo.find('id-1');
      await repo.remove('id-1');

      for (const call of prisma.seen) {
        expect(call.args.where, call.op + ' has no tenant').toHaveProperty(
          'tenantId',
        );
      }
    },
  );
});

describe('query shape', () => {
  it.todo('finds one with findFirst, never findUnique', async () => {
    await repo.find('id-1');
    expect(prisma.seen[0]?.op).toBe('findFirst');
  });

  it.todo('deletes with deleteMany, never delete', async () => {
    await repo.remove('id-1');
    expect(prisma.seen[0]?.op).toBe('deleteMany');
  });

  it.todo(
    'returns null rather than throwing when nothing matches',
    async () => {
      prisma.stylist.findFirst = () => Promise.resolve(null);
      expect(await repo.find('missing')).toBeNull();
    },
  );
});

describe('mapping rows out', () => {
  it('narrows the status string to the domain union', () => {
    const row = StylistRepository.row(STORED);
    expect(row.status).toBe('active');
  });

  it('passes the date through untouched, for the handler to format', () => {
    const row = StylistRepository.row(STORED);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
