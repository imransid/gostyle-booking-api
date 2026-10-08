import { describe, expect, it, vi } from 'vitest';
import { BookingScopeRepository } from './booking-scope.repository';
import type { PrismaService } from './prisma.service';

/**
 * The lookup behind the scope check must find THE SAME ROW the route acts
 * on. These pin how it matches, against the query it sends.
 */

const ID = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const ROW = {
  id: ID,
  code: 'GS-1234',
  customerId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'f2a9882b-c822-4107-b650-29af2e303c24',
  branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
};

function repo() {
  const findUnique = vi.fn(() => Promise.resolve(ROW));
  const prisma = { booking: { findUnique } } as unknown as PrismaService;
  return { r: new BookingScopeRepository(prisma), findUnique };
}

const SELECT = {
  id: true,
  code: true,
  customerId: true,
  tenantId: true,
  branchId: true,
};

describe('byId', () => {
  it('reads one booking by id, the five fields the rule and the log need', async () => {
    const { r, findUnique } = repo();
    expect(await r.byId(ID)).toEqual(ROW);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: ID },
      select: SELECT,
    });
  });

  it.each(['not-a-uuid', '', 'GS-1234', `${ID}x`])(
    '%j: null, and the database is never asked',
    async (id) => {
      const { r, findUnique } = repo();
      expect(await r.byId(id)).toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
    },
  );
});

describe('byCode', () => {
  it('reads one booking by its code', async () => {
    const { r, findUnique } = repo();
    expect(await r.byCode('GS-1234')).toEqual(ROW);
    expect(findUnique).toHaveBeenCalledWith({
      where: { code: 'GS-1234' },
      select: SELECT,
    });
  });

  it.each([' GS-1234', 'GS-1234 ', 'gs-1234'])(
    '%j is matched EXACTLY as sent, as late-capture matches it',
    async (code) => {
      const { r, findUnique } = repo();
      await r.byCode(code);
      expect(findUnique).toHaveBeenCalledWith({
        where: { code },
        select: SELECT,
      });
    },
  );

  it('an empty code: null, and the database is never asked', async () => {
    const { r, findUnique } = repo();
    expect(await r.byCode('')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
