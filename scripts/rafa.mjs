#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────
 *  rafa — scaffold one feature across all four layers, with tests.
 *
 *      pnpm rafa                      ask everything
 *      pnpm rafa customer-note        name given, asks the rest
 *      pnpm rafa customer-note --yes  accept every default, ask nothing
 *
 *  Writes EIGHT files: four layers, four specs. The code compiles, the tests
 *  pass, and every method demonstrates the house pattern:
 *
 *      fetch (infrastructure) -> decide (domain) -> act (infrastructure)
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  DESIGN DECISIONS, so you can change them knowingly:
 *
 *  1. Zero dependencies. node:readline/promises is built in from Node 17.
 *
 *  2. Specs are vitest and colocated, because vitest.config.mts globs
 *     src/**\/*.spec.ts. Test doubles are hand-written classes, not a
 *     mocking library — you can read exactly what they do.
 *
 *  3. It auto-wires the HANDLER and the REPOSITORY, because position inside
 *     `providers` and `exports` is irrelevant.
 *
 *  4. It REFUSES to auto-wire the CONTROLLER. Position in the `controllers`
 *     array is load-bearing — a parameterised route swallows every literal
 *     registered after it — and a script cannot know whether your route
 *     belongs above BookingsController. Getting it wrong is silent: the
 *     endpoint 404s while the suite stays green. So it prints instead.
 *
 *  5. It never overwrites. A clash aborts with nothing written.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = process.cwd();

// ── tiny terminal helpers, no dependency ─────────────────────────────────

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

const die = (msg) => {
  console.error(`\n  ${c.err(msg)}\n`);
  process.exit(1);
};

// ── arguments ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.find((a) => !a.startsWith('-'));
const AUTO = flags.has('--yes') || flags.has('-y');

if (flags.has('--help') || flags.has('-h')) {
  console.log(`
  ${c.b('pnpm rafa')} — scaffold one feature across all four layers

    pnpm rafa                       interactive
    pnpm rafa customer-note         name given, asks the rest
    pnpm rafa customer-note --yes   all defaults, no questions

  Writes eight files — four layers plus a spec for each — wires the handler
  and repository, and prints the controller registration to place by hand.
`);
  process.exit(0);
}

// ── names ────────────────────────────────────────────────────────────────

const toKebab = (s) =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const toPascal = (k) =>
  k
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

/** Good enough for feature names, and the prompt lets you override it. */
const pluralise = (k) => {
  const parts = k.split('-');
  const last = parts[parts.length - 1];
  let p;
  if (/[^aeiou]y$/.test(last)) p = last.slice(0, -1) + 'ies';
  else if (/(s|x|z|ch|sh)$/.test(last)) p = last + 'es';
  else p = last + 's';
  return [...parts.slice(0, -1), p].join('-');
};

// ── prompting ────────────────────────────────────────────────────────────

const rl = AUTO
  ? null
  : createInterface({ input: process.stdin, output: process.stdout });

async function ask(label, fallback, allowed) {
  if (AUTO) return fallback;
  const hint = allowed ? c.dim(` (${allowed.join(' / ')})`) : '';
  const shown = fallback ? c.dim(` [${fallback}]`) : '';
  for (;;) {
    const raw = (await rl.question(`  ${label}${hint}${shown} › `)).trim();
    const value = raw === '' ? fallback : raw;
    if (!value) {
      console.log(`    ${c.err('required')}`);
      continue;
    }
    if (allowed && !allowed.includes(value)) {
      console.log(`    ${c.err('pick one of: ' + allowed.join(', '))}`);
      continue;
    }
    return value;
  }
}

async function confirm(label, fallback) {
  if (AUTO) return fallback;
  const d = fallback ? 'Y/n' : 'y/N';
  const raw = (
    await rl.question(`  ${label} ${c.dim('(' + d + ')')} › `)
  ).trim();
  if (raw === '') return fallback;
  return /^y(es)?$/i.test(raw);
}

console.log(
  `\n  ${c.b('rafa')}  ${c.dim('— new feature: four layers, four specs')}\n`,
);

const rawName =
  positional ?? (await ask('Feature name, kebab-case, singular', ''));
const kebab = toKebab(rawName);
if (!kebab) die('That name has nothing usable in it.');

const pascal = toPascal(kebab);
const snake = kebab.replace(/-/g, '_');
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const words = kebab.replace(/-/g, ' ');
const CONST = snake.toUpperCase();

const area = await ask('Domain area', 'booking', [
  'booking',
  'availability',
  'shared',
]);
const kind = await ask('Handler type', 'command', ['command', 'query']);
const route = await ask('HTTP base path', pluralise(kebab));
const access = await ask('Access', 'desk', ['desk', 'public', 'any']);
const wantPrisma = await confirm('Print a Prisma model to copy?', true);
const wantWire = await confirm('Auto-wire handler + repository?', true);

if (rl) rl.close();

const handlerDir = kind === 'query' ? 'queries' : 'commands';
const inputName = kind === 'query' ? `${pascal}Query` : `Create${pascal}Command`;

/**
 * The controller class follows the ROUTE, not the feature name — this repo
 * writes WalkInsController in walk-ins.controller.ts. Everything else follows
 * the singular feature name.
 */
const controllerClass = `${toPascal(route)}Controller`;

const lifecyclePath =
  area === 'booking' ? './lifecycle' : '@domain/booking/lifecycle';

// ═════════════════════════════════════════════════════════ TEMPLATES ═════
// Generated code avoids backticks on purpose: it keeps this file readable
// and removes a whole class of escaping mistakes.

// ── 1. domain ────────────────────────────────────────────────────────────

const domain = `/**
 * TODO: one sentence, in the salon's own words, saying what this is.
 *
 * PURE. No async, no Prisma, no Nest, no clock. Everything arrives as an
 * argument, which is why the spec beside this file needs no setup at all.
 *
 * A business refusal is RETURNED as a union keyed on 'kind', never thrown.
 * This layer does not know HTTP exists, so it cannot know a refusal should
 * become a 403 or a 409. It states the fact; the handler picks the status.
 */

import type { ActorKind } from '${lifecyclePath}';

export const MAX_${CONST}_LABEL = 200;

export type ${pascal}Status = 'active' | 'archived';

export const ${CONST}_STATUSES: readonly ${pascal}Status[] = [
  'active',
  'archived',
];

export type LabelResult =
  | { readonly kind: 'ok'; readonly label: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Tidy the label and say whether it is usable.
 *
 * Returns the trimmed text rather than changing anything in place, so the
 * caller stores exactly what was approved and never the raw input.
 */
export function clean${pascal}Label(raw: string): LabelResult {
  const label = raw.trim();

  if (label.length === 0) {
    return { kind: 'refused', reason: 'A label cannot be empty.' };
  }
  if (label.length > MAX_${CONST}_LABEL) {
    return { kind: 'refused', reason: 'That label is too long.' };
  }
  return { kind: 'ok', label };
}

export interface ModifyRequest {
  /** Who created the record. */
  readonly authorId: string;
  /** Who is asking to change it now. */
  readonly actorId: string;
  readonly actorKind: ActorKind;
}

export type ModifyDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * You may change your own. A manager may change anyone's.
 *
 * Other staff are refused on purpose: a record of what one person did should
 * not be quietly rewritten by a colleague. Change this if the salon's rule
 * is different — but change it HERE, not in the handler.
 */
export function mayModify${pascal}(req: ModifyRequest): ModifyDecision {
  if (req.actorKind === 'manager') return { kind: 'allowed' };
  if (req.actorId === req.authorId) return { kind: 'allowed' };
  return {
    kind: 'refused',
    reason: 'Only the author or a manager may change this.',
  };
}
`;

// ── 2. domain spec ───────────────────────────────────────────────────────

const domainSpec = `import { describe, it, expect } from 'vitest';
import {
  clean${pascal}Label,
  mayModify${pascal},
  MAX_${CONST}_LABEL,
  type ModifyRequest,
} from './${kebab}';

/**
 * DOMAIN SPEC — the cheapest tests in the codebase.
 *
 * No mocks, no database, no Nest test module, no setup. That is the whole
 * payoff of keeping the rules pure: a thousand cases run in a second.
 *
 * The test names are the business rules written as sentences. Someone who
 * cannot read TypeScript should still be able to read this list and say
 * whether the policy is captured correctly.
 */

describe('tidying a ${words} label', () => {
  it('trims the edges', () => {
    expect(clean${pascal}Label('  hello  ')).toEqual({
      kind: 'ok',
      label: 'hello',
    });
  });

  it('refuses text that is only whitespace', () => {
    expect(clean${pascal}Label('   ').kind).toBe('refused');
  });

  it('refuses text past the limit', () => {
    const long = 'x'.repeat(MAX_${CONST}_LABEL + 1);
    expect(clean${pascal}Label(long).kind).toBe('refused');
  });

  it('accepts text exactly at the limit', () => {
    const exact = 'x'.repeat(MAX_${CONST}_LABEL);
    expect(clean${pascal}Label(exact).kind).toBe('ok');
  });

  it('measures the length AFTER trimming', () => {
    const padded = '  ' + 'x'.repeat(MAX_${CONST}_LABEL) + '  ';
    expect(clean${pascal}Label(padded).kind).toBe('ok');
  });

  it('always gives a reason a client can show the user', () => {
    const d = clean${pascal}Label('');
    if (d.kind !== 'refused') throw new Error('expected a refusal');
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe('who may change a ${words}', () => {
  const base: ModifyRequest = {
    authorId: 'maya',
    actorId: 'maya',
    actorKind: 'staff',
  };

  it('lets the author change their own', () => {
    expect(mayModify${pascal}(base).kind).toBe('allowed');
  });

  it('lets a manager change anyone', () => {
    const d = mayModify${pascal}({
      ...base,
      actorId: 'rana',
      actorKind: 'manager',
    });
    expect(d.kind).toBe('allowed');
  });

  it('refuses a different staff member', () => {
    expect(mayModify${pascal}({ ...base, actorId: 'sara' }).kind).toBe(
      'refused',
    );
  });

  it('refuses a customer', () => {
    const d = mayModify${pascal}({
      ...base,
      actorId: 'dana',
      actorKind: 'customer',
    });
    expect(d.kind).toBe('refused');
  });
});

describe('invariants', () => {
  it('never returns ok with untrimmed text', () => {
    const samples = ['a', ' a', 'a ', '  a  ', 'a b', '\\ta\\n'];
    for (const s of samples) {
      const r = clean${pascal}Label(s);
      if (r.kind !== 'ok') continue;
      expect(r.label).toBe(r.label.trim());
    }
  });

  it('a manager is never refused, whoever wrote it', () => {
    for (const author of ['maya', 'sara', 'dana', 'rana']) {
      const d = mayModify${pascal}({
        authorId: author,
        actorId: 'rana',
        actorKind: 'manager',
      });
      expect(d.kind).toBe('allowed');
    }
  });
});
`;

// ── 3. handler ───────────────────────────────────────────────────────────

const handler = `/**
 * The choreographer. Every method below is the same three beats:
 *
 *     fetch (infrastructure) -> decide (domain) -> act (infrastructure)
 *
 * This is also the ONLY layer that knows a refusal becomes an HTTP status.
 *
 * A plain @Injectable class. NOT @nestjs/cqrs — the package sits in
 * package.json but no bus is wired anywhere, so a @CommandHandler dispatched
 * through a CommandBus would never be discovered and would fail at injection.
 */

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ${pascal}Repository,
  type ${pascal}Row,
} from '@infrastructure/persistence/${kebab}.repository';
import {
  clean${pascal}Label,
  mayModify${pascal},
  type ${pascal}Status,
} from '@domain/${area}/${kebab}';
import type { ActorKind } from '@domain/booking/lifecycle';
import { shout, type Shouted } from '@application/contract/wire';

export interface ${pascal}Actor {
  readonly id: string;
  readonly kind: ActorKind;
}

export interface ${inputName} {
  readonly branchId: string;
  readonly label: string;
}

/**
 * What the client sees. Enums leave SCREAMING_SNAKE and dates leave as ISO
 * strings — the front end should never receive a JS Date or a lowercase
 * status word.
 */
export interface ${pascal}View {
  readonly id: string;
  readonly branchId: string;
  readonly label: string;
  readonly status: Shouted<${pascal}Status>;
  readonly authorId: string;
  readonly createdAt: string;
}

export function to${pascal}View(row: ${pascal}Row): ${pascal}View {
  return {
    id: row.id,
    branchId: row.branchId,
    label: row.label,
    status: shout(row.status),
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ${pascal}Handler {
  constructor(private readonly repo: ${pascal}Repository) {}

  // ── CREATE ────────────────────────────────────────────────────────────
  async create(
    input: ${inputName},
    actor: ${pascal}Actor,
  ): Promise<${pascal}View> {
    // DECIDE first. Never write something the rule has not approved.
    const cleaned = clean${pascal}Label(input.label);
    if (cleaned.kind === 'refused') {
      throw new ConflictException(cleaned.reason);
    }

    // ACT. Note it stores cleaned.label, not input.label.
    const row = await this.repo.create({
      branchId: input.branchId,
      label: cleaned.label,
      authorId: actor.id,
    });

    return to${pascal}View(row);
  }

  // ── READ ──────────────────────────────────────────────────────────────
  /**
   * No rule to ask. Plenty of reads are pure fetching, and inventing a
   * domain function that only ever returns 'allowed' would be ceremony.
   */
  async list(branchId: string): Promise<readonly ${pascal}View[]> {
    const rows = await this.repo.listFor(branchId);
    return rows.map(to${pascal}View);
  }

  async findOne(id: string): Promise<${pascal}View> {
    const row = await this.repo.find(id);
    if (row === null) {
      throw new NotFoundException('No such ${words}.');
    }
    return to${pascal}View(row);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  async update(
    id: string,
    label: string,
    actor: ${pascal}Actor,
  ): Promise<${pascal}View> {
    // FETCH — the rule needs to know who created it.
    const existing = await this.repo.find(id);
    if (existing === null) {
      throw new NotFoundException('No such ${words}.');
    }

    // DECIDE — permission.
    const permission = mayModify${pascal}({
      authorId: existing.authorId,
      actorId: actor.id,
      actorKind: actor.kind,
    });
    if (permission.kind === 'refused') {
      throw new ForbiddenException(permission.reason);
    }

    // DECIDE — content.
    const cleaned = clean${pascal}Label(label);
    if (cleaned.kind === 'refused') {
      throw new ConflictException(cleaned.reason);
    }

    // ACT.
    return to${pascal}View(await this.repo.update(id, cleaned.label));
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  async remove(
    id: string,
    actor: ${pascal}Actor,
  ): Promise<{ message: string }> {
    const existing = await this.repo.find(id);
    if (existing === null) {
      throw new NotFoundException('No such ${words}.');
    }

    const permission = mayModify${pascal}({
      authorId: existing.authorId,
      actorId: actor.id,
      actorKind: actor.kind,
    });
    if (permission.kind === 'refused') {
      throw new ForbiddenException(permission.reason);
    }

    await this.repo.remove(id);
    return { message: 'Removed.' };
  }
}
`;

// ── 4. handler spec ──────────────────────────────────────────────────────

const handlerSpec = `import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ${pascal}Handler, type ${pascal}Actor } from './${kebab}.handler';
import type {
  ${pascal}Repository,
  ${pascal}Row,
} from '@infrastructure/persistence/${kebab}.repository';

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
 */

class Fake${pascal}Repository {
  readonly rows = new Map<string, ${pascal}Row>();
  private seq = 0;

  async create(input: {
    readonly branchId: string;
    readonly label: string;
    readonly authorId: string;
  }): Promise<${pascal}Row> {
    this.seq += 1;
    const row: ${pascal}Row = {
      id: 'id-' + this.seq,
      branchId: input.branchId,
      label: input.label,
      status: 'active',
      authorId: input.authorId,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
    };
    this.rows.set(row.id, row);
    return row;
  }

  async listFor(branchId: string): Promise<readonly ${pascal}Row[]> {
    return [...this.rows.values()].filter((r) => r.branchId === branchId);
  }

  async find(id: string): Promise<${pascal}Row | null> {
    return this.rows.get(id) ?? null;
  }

  async update(id: string, label: string): Promise<${pascal}Row> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      throw new Error('fake: update called for a row that is not there');
    }
    const next = { ...existing, label };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<number> {
    return this.rows.delete(id) ? 1 : 0;
  }
}

const MAYA: ${pascal}Actor = { id: 'maya', kind: 'staff' };
const SARA: ${pascal}Actor = { id: 'sara', kind: 'staff' };
const RANA: ${pascal}Actor = { id: 'rana', kind: 'manager' };

let fake: Fake${pascal}Repository;
let handler: ${pascal}Handler;

beforeEach(() => {
  fake = new Fake${pascal}Repository();
  handler = new ${pascal}Handler(fake as unknown as ${pascal}Repository);
});

describe('creating', () => {
  it('stores the TRIMMED label, not the raw input', async () => {
    const view = await handler.create(
      { branchId: 'marina-walk', label: '  padded  ' },
      MAYA,
    );
    expect(view.label).toBe('padded');
    expect(fake.rows.get(view.id)?.label).toBe('padded');
  });

  it('stamps the acting user as the author', async () => {
    const view = await handler.create(
      { branchId: 'marina-walk', label: 'hello' },
      MAYA,
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
    const view = await handler.create(
      { branchId: 'marina-walk', label: 'hello' },
      MAYA,
    );
    expect(view.status).toBe('ACTIVE');
  });

  it('sends the date out as an ISO string, never a Date', async () => {
    const view = await handler.create(
      { branchId: 'marina-walk', label: 'hello' },
      MAYA,
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
  it('lets the author change their own', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'before' },
      MAYA,
    );
    const after = await handler.update(made.id, 'after', MAYA);
    expect(after.label).toBe('after');
  });

  it('lets a manager change someone else’s', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'before' },
      MAYA,
    );
    const after = await handler.update(made.id, 'after', RANA);
    expect(after.label).toBe('after');
  });

  it('403s for a different staff member, and changes nothing', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'before' },
      MAYA,
    );
    await expect(
      handler.update(made.id, 'after', SARA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fake.rows.get(made.id)?.label).toBe('before');
  });

  it('404s before it checks permission, so a bad id never leaks', async () => {
    await expect(
      handler.update('missing', 'after', SARA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s on an empty label, and changes nothing', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'before' },
      MAYA,
    );
    await expect(handler.update(made.id, '  ', MAYA)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fake.rows.get(made.id)?.label).toBe('before');
  });

  it('trims on update as well as on create', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'before' },
      MAYA,
    );
    const after = await handler.update(made.id, '  after  ', MAYA);
    expect(after.label).toBe('after');
  });
});

describe('removing', () => {
  it('lets the author remove their own', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'a' },
      MAYA,
    );
    await handler.remove(made.id, MAYA);
    expect(fake.rows.size).toBe(0);
  });

  it('403s for a different staff member, and removes nothing', async () => {
    const made = await handler.create(
      { branchId: 'marina-walk', label: 'a' },
      MAYA,
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
`;

// ── 5. repository ────────────────────────────────────────────────────────

const repository = `/**
 * Rows in, rows out. Every method here is an await on Postgres and nothing
 * else. It has no opinion about whether any of it is allowed — the handler
 * already asked the rule before calling.
 *
 * NEVER inject an application port here. The handler owns the ports and
 * passes down whatever answer they gave.
 *
 * TENANT SCOPING is why find() uses findFirst rather than findUnique: a row
 * belonging to another salon must come back as null so the handler answers
 * 404, not 403. A 403 would confirm the id exists.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import type { ${pascal}Status } from '@domain/${area}/${kebab}';

export interface ${pascal}Row {
  readonly id: string;
  readonly branchId: string;
  readonly label: string;
  readonly status: ${pascal}Status;
  readonly authorId: string;
  readonly createdAt: Date;
}

@Injectable()
export class ${pascal}Repository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  /** The request's tenant, or null. See tenancy/tenant-context.ts. */
  private tenantId(): string | null {
    return this.tenants.current();
  }

  static row(r: {
    id: string;
    branchId: string;
    label: string;
    status: string;
    authorId: string;
    createdAt: Date;
  }): ${pascal}Row {
    return { ...r, status: r.status as ${pascal}Status };
  }

  // ── CREATE ────────────────────────────────────────────────────────────
  async create(input: {
    readonly branchId: string;
    readonly label: string;
    readonly authorId: string;
  }): Promise<${pascal}Row> {
    const row = await this.prisma.${camel}.create({
      data: { ...input, tenantId: this.tenantId() },
    });
    return ${pascal}Repository.row(row);
  }

  // ── READ (many) ───────────────────────────────────────────────────────
  async listFor(branchId: string): Promise<readonly ${pascal}Row[]> {
    const rows = await this.prisma.${camel}.findMany({
      where: { branchId, tenantId: this.tenantId() },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(${pascal}Repository.row);
  }

  // ── READ (one) ────────────────────────────────────────────────────────
  async find(id: string): Promise<${pascal}Row | null> {
    const row = await this.prisma.${camel}.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : ${pascal}Repository.row(row);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  async update(id: string, label: string): Promise<${pascal}Row> {
    const row = await this.prisma.${camel}.update({
      where: { id },
      data: { label },
    });
    return ${pascal}Repository.row(row);
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  /**
   * deleteMany, not delete, with the tenant in the where clause. delete()
   * throws when nothing matches; deleteMany returns a count, so a
   * cross-tenant id quietly removes nothing instead of exploding.
   */
  async remove(id: string): Promise<number> {
    const { count } = await this.prisma.${camel}.deleteMany({
      where: { id, tenantId: this.tenantId() },
    });
    return count;
  }
}
`;

// ── 6. repository spec ───────────────────────────────────────────────────

const repositorySpec = `import { describe, it, expect, beforeEach } from 'vitest';
import { ${pascal}Repository } from './${kebab}.repository';
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
  readonly args: { data?: Record<string, unknown>; where?: Record<string, unknown> };
}

class FakePrisma {
  readonly seen: Call[] = [];

  private record(op: string, args: Call['args']): void {
    this.seen.push({ op, args });
  }

  readonly ${camel} = {
    create: async (args: Call['args']) => {
      this.record('create', args);
      return { ...STORED, ...args.data };
    },
    findMany: async (args: Call['args']) => {
      this.record('findMany', args);
      return [STORED];
    },
    findFirst: async (
      args: Call['args'],
    ): Promise<typeof STORED | null> => {
      this.record('findFirst', args);
      return STORED;
    },
    update: async (args: Call['args']) => {
      this.record('update', args);
      return { ...STORED, ...args.data };
    },
    deleteMany: async (args: Call['args']) => {
      this.record('deleteMany', args);
      return { count: 1 };
    },
  };
}

const tenants = { current: () => TENANT } as unknown as TenantContext;

let prisma: FakePrisma;
let repo: ${pascal}Repository;

beforeEach(() => {
  prisma = new FakePrisma();
  repo = new ${pascal}Repository(prisma as unknown as PrismaService, tenants);
});

describe('tenant scoping', () => {
  it('stamps the tenant on every write', async () => {
    await repo.create({
      branchId: 'marina-walk',
      label: 'hello',
      authorId: 'maya',
    });
    expect(prisma.seen[0]?.args.data?.tenantId).toBe(TENANT);
  });

  it('filters the list by tenant AND branch', async () => {
    await repo.listFor('marina-walk');
    expect(prisma.seen[0]?.args.where).toEqual({
      branchId: 'marina-walk',
      tenantId: TENANT,
    });
  });

  it('carries the tenant on the single read', async () => {
    await repo.find('id-1');
    expect(prisma.seen[0]?.args.where?.tenantId).toBe(TENANT);
  });

  it('carries the tenant on delete', async () => {
    await repo.remove('id-1');
    expect(prisma.seen[0]?.args.where).toEqual({
      id: 'id-1',
      tenantId: TENANT,
    });
  });

  it('every read and delete names the tenant — none may be forgotten', async () => {
    await repo.listFor('marina-walk');
    await repo.find('id-1');
    await repo.remove('id-1');

    for (const call of prisma.seen) {
      expect(call.args.where, call.op + ' has no tenant').toHaveProperty(
        'tenantId',
      );
    }
  });
});

describe('query shape', () => {
  it('finds one with findFirst, never findUnique', async () => {
    await repo.find('id-1');
    expect(prisma.seen[0]?.op).toBe('findFirst');
  });

  it('deletes with deleteMany, never delete', async () => {
    await repo.remove('id-1');
    expect(prisma.seen[0]?.op).toBe('deleteMany');
  });

  it('returns null rather than throwing when nothing matches', async () => {
    prisma.${camel}.findFirst = async () => null;
    expect(await repo.find('missing')).toBeNull();
  });
});

describe('mapping rows out', () => {
  it('narrows the status string to the domain union', () => {
    const row = ${pascal}Repository.row(STORED);
    expect(row.status).toBe('active');
  });

  it('passes the date through untouched, for the handler to format', () => {
    const row = ${pascal}Repository.row(STORED);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
`;

// ── 7. controller ────────────────────────────────────────────────────────

const accessImport =
  access === 'desk'
    ? "import { DeskOnly } from '../../auth/desk-only.decorator';\n"
    : access === 'public'
      ? "import { Public } from '../../auth/public.decorator';\n"
      : '';

const accessDecorator =
  access === 'desk' ? '@DeskOnly()\n' : access === 'public' ? '@Public()\n' : '';

const accessNote =
  access === 'desk'
    ? ' *\n * @DeskOnly at class level: a customer token is refused on every route.'
    : access === 'public'
      ? ' *\n * @Public at class level. It opens the guard AND the OpenAPI operation,\n * which is why it is one decorator and not two.'
      : ' *\n * No access decorator, so the global guard applies: any valid bearer token\n * gets through, customer or staff.';

const controller = `/**
 * The front door. Checks the form, works out who is asking, hands it on.
 * It decides nothing about the business.
${accessNote}
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import {
  ${pascal}Handler,
  type ${pascal}View,
} from '@application/${handlerDir}/${kebab}.handler';
import { MAX_${CONST}_LABEL } from '@domain/${area}/${kebab}';
import { ResourceIdPipe } from './resource-id.pipe';
${accessImport}import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

/**
 * DTOs LIVE AT THE TOP OF THIS FILE, above the controller.
 *
 * Moving them into a separate .dto.ts opts every field out of
 * contract-vocabulary.spec.ts, which only scans *.controller.ts — and the
 * suite stays green while it does.
 *
 * EVERY field carries a class-validator decorator, not only @ApiProperty.
 * The global pipe runs with whitelist:true, so a documented-but-unvalidated
 * field is silently stripped and reaches the handler as undefined, with no
 * error anywhere. The spec beside this file asserts it.
 */
export class Create${pascal}Dto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;

  @ApiProperty({ example: 'A short human label' })
  @IsString()
  @MaxLength(MAX_${CONST}_LABEL)
  label!: string;
}

/**
 * A query DTO, not bare @Query('x') arguments.
 *
 * There is no @ApiQuery anywhere in this codebase, so a bare @Query is
 * invisible in /docs: the operation publishes no parameters at all and a
 * client generated from the spec cannot call it. A DTO documents and
 * validates in one move.
 */
export class List${pascal}Dto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;
}

export class Update${pascal}Dto {
  @ApiProperty({ example: 'A corrected label' })
  @IsString()
  @MaxLength(MAX_${CONST}_LABEL)
  label!: string;
}

@ApiTags('${route}')
${accessDecorator}@Controller('${route}')
export class ${controllerClass} {
  constructor(private readonly handler: ${pascal}Handler) {}

  // Single-quoted literal paths. route-order.spec.ts is a source regex and
  // recognises nothing else — double quotes, a constant, or the options form
  // @Controller({ path }) make it report ZERO routes, so its shadowing check
  // passes vacuously while the endpoint is genuinely unreachable.
  //
  // Literal routes are declared BEFORE ':id' routes, both in this file and
  // in the module's controllers array.

  @Post()
  @ApiOperation({ summary: 'TODO: what a salon person would call this' })
  @ApiCreatedResponse({ description: 'Created.' })
  @ApiConflictResponse({ description: 'The label is empty or too long.' })
  create(
    @Body() dto: Create${pascal}Dto,
    @CurrentActor() actor: Actor,
  ): Promise<${pascal}View> {
    return this.handler.create(
      { branchId: dto.branchId, label: dto.label },
      { id: actor.id, kind: actor.kind },
    );
  }

  @Get()
  @ApiOperation({ summary: 'Every ${words} for a branch, newest first' })
  @ApiOkResponse({ description: 'The list, possibly empty.' })
  list(@Query() query: List${pascal}Dto): Promise<readonly ${pascal}View[]> {
    return this.handler.list(query.branchId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One ${words}' })
  @ApiOkResponse({ description: 'Found.' })
  @ApiNotFoundResponse({ description: 'No such ${words}.' })
  findOne(@Param('id', ResourceIdPipe) id: string): Promise<${pascal}View> {
    return this.handler.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change the label',
    description: 'The author, or a manager. Other staff are refused.',
  })
  @ApiOkResponse({ description: 'Updated.' })
  @ApiNotFoundResponse({ description: 'No such ${words}.' })
  @ApiForbiddenResponse({ description: 'Not yours to change.' })
  @ApiConflictResponse({ description: 'The label is empty or too long.' })
  update(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: Update${pascal}Dto,
    @CurrentActor() actor: Actor,
  ): Promise<${pascal}View> {
    return this.handler.update(id, dto.label, {
      id: actor.id,
      kind: actor.kind,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove it' })
  @ApiOkResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: 'No such ${words}.' })
  @ApiForbiddenResponse({ description: 'Not yours to remove.' })
  remove(
    @Param('id', ResourceIdPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ message: string }> {
    return this.handler.remove(id, { id: actor.id, kind: actor.kind });
  }
}
`;

// ── 8. controller spec ───────────────────────────────────────────────────

const controllerSpec = `import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ${controllerClass} } from './${route}.controller';
import type { ${pascal}Handler } from '@application/${handlerDir}/${kebab}.handler';
import type { Actor } from '../../auth/actor';

/**
 * CONTROLLER SPEC — two halves, both about silent failures.
 *
 * 1. WIRING. The controller must pass the acting user through and must not
 *    invent, default or reshape anything. A default on an identity field is
 *    how a booking silently ends up against the wrong customer.
 *
 * 2. THE SOURCE ITSELF, scanned as text — the same technique as
 *    route-order.spec.ts and contract-vocabulary.spec.ts. The global
 *    ValidationPipe runs with whitelist:true, so a DTO field carrying only
 *    @ApiProperty is STRIPPED before the handler sees it, with no error
 *    anywhere. Nothing else in the codebase catches that.
 */

const SOURCE = join(
  process.cwd(),
  'src',
  'interface',
  'http',
  '${route}.controller.ts',
);

const ACTOR = {
  id: 'maya',
  kind: 'staff',
  branchId: null,
  tenantId: null,
} as Actor;

interface Seen {
  readonly method: string;
  readonly args: readonly unknown[];
}

class FakeHandler {
  readonly seen: Seen[] = [];

  private record(method: string, args: readonly unknown[]): void {
    this.seen.push({ method, args });
  }

  async create(...args: readonly unknown[]) {
    this.record('create', args);
    return {} as never;
  }
  async list(...args: readonly unknown[]) {
    this.record('list', args);
    return [] as never;
  }
  async findOne(...args: readonly unknown[]) {
    this.record('findOne', args);
    return {} as never;
  }
  async update(...args: readonly unknown[]) {
    this.record('update', args);
    return {} as never;
  }
  async remove(...args: readonly unknown[]) {
    this.record('remove', args);
    return {} as never;
  }
}

let fake: FakeHandler;
let controller: ${controllerClass};

beforeEach(() => {
  fake = new FakeHandler();
  controller = new ${controllerClass}(fake as unknown as ${pascal}Handler);
});

describe('passing the request on', () => {
  it('sends the acting user, never a value from the body', async () => {
    await controller.create(
      { branchId: 'marina-walk', label: 'hello' },
      ACTOR,
    );
    expect(fake.seen[0]?.args[1]).toEqual({ id: 'maya', kind: 'staff' });
  });

  it('sends the body fields through unchanged', async () => {
    await controller.create(
      { branchId: 'marina-walk', label: '  padded  ' },
      ACTOR,
    );
    // Untouched — trimming is the domain's job, not the door's.
    expect(fake.seen[0]?.args[0]).toEqual({
      branchId: 'marina-walk',
      label: '  padded  ',
    });
  });

  it('passes the id, the label and the actor when updating', async () => {
    await controller.update('id-1', { label: 'next' }, ACTOR);
    expect(fake.seen[0]?.args).toEqual([
      'id-1',
      'next',
      { id: 'maya', kind: 'staff' },
    ]);
  });

  it('passes the id and the actor when removing', async () => {
    await controller.remove('id-1', ACTOR);
    expect(fake.seen[0]?.args).toEqual(['id-1', { id: 'maya', kind: 'staff' }]);
  });

  it('reads the branch from the query DTO', async () => {
    await controller.list({ branchId: 'marina-walk' });
    expect(fake.seen[0]?.args[0]).toBe('marina-walk');
  });
});

/** Blank out comments, keeping the line count, exactly as the other scanners do. */
function stripComments(src: string): string {
  return src
    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, (m) => m.replace(/[^\\n]/g, ' '))
    .replace(/\\/\\/[^\\n]*/g, (m) => ' '.repeat(m.length));
}

const VALIDATOR =
  /@(Is[A-Z]\\w*|Matches|Min|Max|MinLength|MaxLength|Length|Allow|Type|ValidateNested|WireEnum|ArrayMinSize|ArrayMaxSize)\\b/;

describe('the DTOs in this file', () => {
  const src = stripComments(readFileSync(SOURCE, 'utf8'));

  const blocks = [...src.matchAll(/export class (\\w+Dto)\\s*\\{([\\s\\S]*?)\\n\\}/g)];

  it('finds the DTO classes to check', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  for (const block of blocks) {
    const name = block[1]!;
    const body = block[2]!;

    it(name + ': every property carries a class-validator decorator', () => {
      const bad: string[] = [];

      for (const chunk of body.split(/\\n\\s*\\n/)) {
        const prop = /^\\s*(\\w+)[!?]\\s*:/m.exec(chunk);
        if (prop === null) continue;
        if (!VALIDATOR.test(chunk)) {
          bad.push(
            prop[1] +
              ' has no validator. whitelist:true STRIPS it before the ' +
              'handler runs, and nothing reports an error.',
          );
        }
      }

      expect(bad).toEqual([]);
    });

    it(name + ': never defaults an identity field', () => {
      // An initialised default on a branch is harmless. On a customer or
      // author id it silently books for the fixture user instead of 400ing.
      const bad = [...body.matchAll(/^\\s*(\\w*[Ii]d)\\s*=\\s*/gm)].map(
        (m) => m[1],
      );
      expect(bad).toEqual([]);
    });
  }
});
`;

const prismaModel = `
// ─────────────────────────────────────────────────────────── ${words}
model ${pascal} {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String?  @map("tenant_id") @db.Uuid
  branchId  String   @map("branch_id")
  label     String
  status    String   @default("active")
  authorId  String   @map("author_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@index([tenantId, branchId], map: "${snake}_tenant_branch")
  @@map("${snake}")
}
`;

// ═════════════════════════════════════════════════════════════ WRITE ═════

const files = [
  [`src/domain/${area}/${kebab}.ts`, domain],
  [`src/domain/${area}/${kebab}.spec.ts`, domainSpec],
  [`src/application/${handlerDir}/${kebab}.handler.ts`, handler],
  [`src/application/${handlerDir}/${kebab}.handler.spec.ts`, handlerSpec],
  [`src/infrastructure/persistence/${kebab}.repository.ts`, repository],
  [`src/infrastructure/persistence/${kebab}.repository.spec.ts`, repositorySpec],
  [`src/interface/http/${route}.controller.ts`, controller],
  [`src/interface/http/${route}.controller.spec.ts`, controllerSpec],
];

const clashes = files.filter(([p]) => existsSync(join(ROOT, p)));
if (clashes.length > 0) {
  console.error(`\n  ${c.err('Refusing to overwrite:')}\n`);
  for (const [p] of clashes) console.error(`    ${p}`);
  console.error('\n  Nothing was written. Delete them, or pick another name.\n');
  process.exit(1);
}

console.log('');
for (const [path, body] of files) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
  const tag = path.endsWith('.spec.ts') ? c.dim('  spec') : c.ok('created');
  console.log(`  ${tag}  ${relative(ROOT, full)}`);
}

// ── auto-wiring, only where order does not matter ────────────────────────

/**
 * Index of the `]` closing the `[` at `open`, ignoring brackets inside
 * strings and comments, and counting nesting on the way.
 *
 * A REGEX CANNOT DO THIS, and the one that used to be here got it wrong.
 * `providers: [` in persistence.module.ts contains a nested `inject: [...]`
 * for the EVENT_PUBLISHER factory, and a non-greedy `[\s\S]*?` stops at the
 * FIRST `\n\s*]` it meets -- the inject array's. So the new repository was
 * appended to that factory's dependency list instead of to providers, and
 * Nest then refused at boot to export a provider it had never been given.
 * It reads as a hand-wiring typo rather than a scaffolder bug, which is the
 * expensive kind. Only availability.module.ts survived it, by luck: its
 * providers array happens to hold no nested array.
 */
function matchingBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const shut = src.indexOf('*/', i + 2);
      if (shut < 0) break;
      i = shut + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Insert `entry` just before the closing bracket of the named array, and add
 * an import after the last existing import. Refuses on any ambiguity -- a
 * half-applied edit to a module file is worse than no edit at all.
 */
function insertInto(file, arrayName, entry, importLine) {
  const full = join(ROOT, file);
  if (!existsSync(full)) return `${file} not found`;

  let src = readFileSync(full, 'utf8');

  const head = new RegExp(`\\b${arrayName}\\s*:\\s*\\[`).exec(src);
  if (head === null) return `could not find the ${arrayName} array in ${file}`;

  const open = head.index + head[0].length - 1; // the '[' itself
  const close = matchingBracket(src, open);
  if (close < 0) return `the ${arrayName} array in ${file} is never closed`;

  const body = src.slice(open + 1, close);
  if (new RegExp(`\\b${entry}\\b`).test(body)) {
    return `${entry} is already in ${arrayName}`;
  }

  // Keep the file's own shape: the closing bracket's indent, and one level
  // deeper than that for the entry itself.
  const closeIndent = (/\n([ \t]*)$/.exec(body) ?? [, '  '])[1];

  // The body may or may not end with a trailing comma. Strip it and re-add
  // exactly one, or an array written with a trailing comma gets two.
  const trimmed = body.replace(/\s+$/, '').replace(/,$/, '');
  const prefix = trimmed.trim() === '' ? '' : `${trimmed},`;

  src =
    src.slice(0, open + 1) +
    `${prefix}\n${closeIndent}  ${entry},\n${closeIndent}` +
    src.slice(close);

  if (!src.includes(importLine)) {
    const imports = [...src.matchAll(/^import [\s\S]*?;$/gm)];
    if (imports.length === 0) return `no imports found in ${file}`;
    const last = imports[imports.length - 1];
    const at = last.index + last[0].length;
    src = src.slice(0, at) + '\n' + importLine + src.slice(at);
  }

  writeFileSync(full, src, 'utf8');
  return null;
}

const problems = [];

if (wantWire) {
  console.log('');
  const edits = [
    [
      'src/availability.module.ts',
      'providers',
      `${pascal}Handler`,
      `import { ${pascal}Handler } from '@application/${handlerDir}/${kebab}.handler';`,
    ],
    [
      'src/infrastructure/persistence/persistence.module.ts',
      'providers',
      `${pascal}Repository`,
      `import { ${pascal}Repository } from './${kebab}.repository';`,
    ],
    [
      'src/infrastructure/persistence/persistence.module.ts',
      'exports',
      `${pascal}Repository`,
      `import { ${pascal}Repository } from './${kebab}.repository';`,
    ],
  ];

  for (const [file, arr, entry, imp] of edits) {
    const err = insertInto(file, arr, entry, imp);
    if (err) problems.push(err);
    else console.log(`  ${c.ok('wired')}   ${entry} -> ${file} ${c.dim(arr)}`);
  }
}

// ── what is left for you ─────────────────────────────────────────────────

console.log(`\n  ${c.b('STILL YOURS TO DO')}\n`);

if (problems.length > 0) {
  console.log(`  ${c.warn('Auto-wiring did not finish:')}`);
  for (const p of problems) console.log(`    - ${p}`);
  console.log('');
}

let n = 1;

console.log(`  ${c.b(n++ + '.')} Register the controller by hand — ${c.warn('position matters')}

     src/availability.module.ts

       import { ${controllerClass} } from '@interface/http/${route}.controller';

       controllers: [
         ...
         ${controllerClass},${c.dim('   <- above any controller with a matching :id route')}
       ]

     A parameterised route swallows every literal registered after it,
     across controllers as well as by line within one file. Forget the array
     entirely and every route 404s while the suite stays green. Nothing
     catches that, which is why it is not automated.
`);

if (wantPrisma) {
  console.log(`  ${c.b(n++ + '.')} Add the table — paste into prisma/schema.prisma
${prismaModel}
       npx prisma migrate dev --name ${snake}
`);
}

console.log(`  ${c.b(n++ + '.')} Run the tests — four specs came with the code

     pnpm vitest run ${kebab}

     Then the full gates:
     npx prisma generate && pnpm typecheck && pnpm lint && pnpm test:unit

  ${c.b(n++ + '.')} Read what was written, in request order

     src/interface/http/${route}.controller.ts
     src/application/${handlerDir}/${kebab}.handler.ts
     src/domain/${area}/${kebab}.ts
     src/infrastructure/persistence/${kebab}.repository.ts

  ${c.dim('Note: these specs are vitest, matching vitest.config.mts. `pnpm test`')}
  ${c.dim('runs jest, which has no alias mapping, so use pnpm test:unit.')}
`);
