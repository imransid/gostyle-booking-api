import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { StylistHandler, type StylistActor } from './stylist.handler';
import type {
  StylistRepository,
  StylistRow,
} from '@infrastructure/persistence/stylist.repository';

/**
 * HANDLER SPEC — proves the CHOREOGRAPHY, not the rules.
 *
 * The rules already have their own spec next to them in src/domain. What is
 * worth testing here is that the handler:
 *   - asks the rule BEFORE it writes,
 *   - stores what the rule approved rather than the raw input,
 *   - turns each kind of refusal into the right HTTP status.
 *
 * The double is a hand-written class, not a mocking library. You can read
 * exactly what it does, and it fails loudly if the handler calls it wrongly.
 *
 * THE it.todo TESTS ARE WAITING ON THE TABLE. StylistRepository's bodies are
 * commented out until the `stylist` model exists (see stylists.controller.ts),
 * so StylistHandler.update answers null whatever the fake returns. The tests
 * that need a real update are kept, not deleted: flip them back to `it` the
 * day the repository is implemented, and delete present() with the nulls.
 */

/** The handler is typed `| null` while the repository is a stub. */
function present<T>(value: T | null): T {
  if (value === null) {
    throw new Error('handler answered null: StylistRepository is a stub');
  }
  return value;
}

class FakeStylistRepository {
  readonly rows = new Map<string, StylistRow>();
  private seq = 0;

  create(input: {
    readonly branchId: string;
    readonly label: string;
    readonly authorId: string;
  }): Promise<StylistRow> {
    this.seq += 1;
    const row: StylistRow = {
      id: 'id-' + this.seq,
      branchId: input.branchId,
      label: input.label,
      status: 'active',
      authorId: input.authorId,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  listFor(branchId: string): Promise<readonly StylistRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.branchId === branchId),
    );
  }

  find(id: string): Promise<StylistRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  update(id: string, label: string): Promise<StylistRow> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      return Promise.reject(
        new Error('fake: update called for a row that is not there'),
      );
    }
    const next = { ...existing, label };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  remove(id: string): Promise<number> {
    return Promise.resolve(this.rows.delete(id) ? 1 : 0);
  }
}

const MAYA: StylistActor = { id: 'maya', kind: 'staff' };
const SARA: StylistActor = { id: 'sara', kind: 'staff' };
const RANA: StylistActor = { id: 'rana', kind: 'manager' };

let fake: FakeStylistRepository;
let handler: StylistHandler;

beforeEach(() => {
  fake = new FakeStylistRepository();
  handler = new StylistHandler(fake as unknown as StylistRepository);
});

describe('creating', () => {
  it('stores the TRIMMED label, not the raw input', async () => {
    const view = present(
      await handler.create(
        { branchId: 'marina-walk', label: '  padded  ' },
        MAYA,
      ),
    );
    expect(view.label).toBe('padded');
    expect(fake.rows.get(view.id)?.label).toBe('padded');
  });

  it('stamps the acting user as the author', async () => {
    const view = present(
      await handler.create({ branchId: 'marina-walk', label: 'hello' }, MAYA),
    );
    expect(view.authorId).toBe('maya');
  });

  it('refuses an empty label with a 409, and writes nothing', async () => {
    await expect(
      handler.create({ branchId: 'marina-walk', label: '   ' }, MAYA),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fake.rows.size).toBe(0);
  });

  it('shouts the status on the way out', async () => {
    const view = present(
      await handler.create({ branchId: 'marina-walk', label: 'hello' }, MAYA),
    );
    expect(view.status).toBe('ACTIVE');
  });

  it('sends the date out as an ISO string, never a Date', async () => {
    const view = present(
      await handler.create({ branchId: 'marina-walk', label: 'hello' }, MAYA),
    );
    expect(typeof view.createdAt).toBe('string');
    expect(view.createdAt).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('reading', () => {
  it('returns only the rows for that branch', async () => {
    await handler.create({ branchId: 'marina-walk', label: 'a' }, MAYA);
    await handler.create({ branchId: 'city-walk', label: 'b' }, MAYA);

    const list = await handler.list('marina-walk');
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('a');
  });

  it('returns an empty list rather than throwing', async () => {
    expect(await handler.list('nowhere')).toEqual([]);
  });

  it('404s for an id that is not there', async () => {
    await expect(handler.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('updating', () => {
  it.todo('lets the author change their own', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'before' }, MAYA),
    );
    const after = present(await handler.update(made.id, 'after', MAYA));
    expect(after.label).toBe('after');
  });

  it.todo('lets a manager change someone else’s', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'before' }, MAYA),
    );
    const after = present(await handler.update(made.id, 'after', RANA));
    expect(after.label).toBe('after');
  });

  it('403s for a different staff member, and changes nothing', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'before' }, MAYA),
    );
    await expect(handler.update(made.id, 'after', SARA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fake.rows.get(made.id)?.label).toBe('before');
  });

  it('404s before it checks permission, so a bad id never leaks', async () => {
    await expect(
      handler.update('missing', 'after', SARA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s on an empty label, and changes nothing', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'before' }, MAYA),
    );
    await expect(handler.update(made.id, '  ', MAYA)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fake.rows.get(made.id)?.label).toBe('before');
  });

  it.todo('trims on update as well as on create', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'before' }, MAYA),
    );
    const after = present(await handler.update(made.id, '  after  ', MAYA));
    expect(after.label).toBe('after');
  });
});

describe('removing', () => {
  it('lets the author remove their own', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'a' }, MAYA),
    );
    await handler.remove(made.id, MAYA);
    expect(fake.rows.size).toBe(0);
  });

  it('403s for a different staff member, and removes nothing', async () => {
    const made = present(
      await handler.create({ branchId: 'marina-walk', label: 'a' }, MAYA),
    );
    await expect(handler.remove(made.id, SARA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(fake.rows.size).toBe(1);
  });

  it('404s for an id that is not there', async () => {
    await expect(handler.remove('missing', RANA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
