import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A parameterised route swallows every literal registered after it.
 *
 * Express matches in registration order, so `GET bookings/:id` registered
 * before `GET bookings/settings` means the settings handler never runs: the
 * request arrives at BookingsController with id = "settings". The failure is
 * quiet — a plausible-looking answer from the wrong handler — which is why
 * this is a test and not a note in a review checklist.
 *
 * ACROSS CONTROLLERS, NOT JUST WITHIN ONE. /v1/bookings/settings lives in
 * SettingsController and /v1/bookings/:id in BookingsController, and the only
 * thing keeping the first reachable is that it appears earlier in the
 * module's `controllers` array. Reordering that array is a one-line edit that
 * silently unroutes an endpoint, so the order is asserted here.
 *
 * Read from the SOURCE, not from a booted app: this has to fail on the pull
 * request that introduces the problem, not on the first request in production
 * that happens to hit the shadowed path.
 */

const HTTP = join(process.cwd(), 'src', 'interface', 'http');
const MODULE = join(process.cwd(), 'src', 'availability.module.ts');

interface Route {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly line: number;
}

/** The order Nest registers them in: the module's `controllers` array. */
function registrationOrder(): string[] {
  const src = readFileSync(MODULE, 'utf8');
  const block = /controllers:\s*\[([^\]]*)\]/.exec(src);
  if (block === null) throw new Error('no controllers array in the module');
  return block[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('//'));
}

function fileFor(className: string): string | null {
  for (const f of readdirSync(HTTP).filter((x) =>
    x.endsWith('.controller.ts'),
  )) {
    const src = stripComments(readFileSync(join(HTTP, f), 'utf8'));
    if (new RegExp(`export class ${className}\\b`).test(src)) return f;
  }
  return null;
}

/**
 * Blank out comments, keeping the line count.
 *
 * Without this the scanner reads decorators out of prose: the doc comment on
 * SettingsController mentions @Get(':id') to explain why the ordering
 * matters, and the first run of this spec duly reported that comment as a
 * route shadowing the endpoint it was describing.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function routesOf(file: string, className: string): Route[] {
  const src = stripComments(readFileSync(join(HTTP, file), 'utf8'));
  const base = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(src)?.[1] ?? '';
  const out: Route[] = [];
  src.split('\n').forEach((text, i) => {
    const m = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(text);
    if (m === null) return;
    const full = [base, m[2] ?? ''].filter(Boolean).join('/');
    out.push({ method: m[1]!, path: full, controller: className, line: i + 1 });
  });
  return out;
}

/** Does the earlier parameterised path swallow the later literal one? */
function shadows(param: string, literal: string): boolean {
  const a = param.split('/').filter(Boolean);
  const b = literal.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

/** Every route, in the order Express will try them. */
function routeTable(): Route[] {
  return registrationOrder().flatMap((cls) => {
    const file = fileFor(cls);
    return file === null ? [] : routesOf(file, cls);
  });
}

describe('route registration order', () => {
  it('reads the module and finds every controller', () => {
    const names = registrationOrder();
    expect(names.length).toBeGreaterThan(10);
    for (const n of names)
      expect(fileFor(n), `${n} has no file`).not.toBeNull();
  });

  it('no literal route is shadowed by an earlier parameterised one', () => {
    const table = routeTable();
    const problems: string[] = [];

    table.forEach((later, j) => {
      if (later.path.includes(':')) return; // only literals can be shadowed
      table.slice(0, j).forEach((earlier) => {
        if (earlier.method !== later.method) return;
        if (!earlier.path.includes(':')) return;
        if (shadows(earlier.path, later.path)) {
          problems.push(
            `@${later.method}('/${later.path}') in ${later.controller} ` +
              `(line ${later.line}) is unreachable: ` +
              `@${earlier.method}('/${earlier.path}') in ${earlier.controller} ` +
              `(line ${earlier.line}) is registered first. Move the literal ` +
              `route — or its controller — above it.`,
          );
        }
      });
    });

    expect(problems).toEqual([]);
  });

  it('keeps the two /bookings literals ahead of /bookings/:id', () => {
    // The specific arrangement the front-end contract depends on, asserted by
    // name so that reordering the controllers array fails loudly here rather
    // than quietly in production.
    const order = registrationOrder();
    const bookings = order.indexOf('BookingsController');
    expect(bookings).toBeGreaterThan(-1);
    expect(order.indexOf('SettingsController')).toBeLessThan(bookings);
    expect(order.indexOf('EligibleStaffController')).toBeLessThan(bookings);
  });

  it('the two literals really are under /bookings', () => {
    const table = routeTable();
    // The decorator's own casing, so a failure prints what the source says.
    const paths = table.map((r) => `${r.method} /${r.path}`);
    expect(paths).toContain('Get /bookings/settings');
    expect(paths).toContain('Get /bookings/eligible-staff');
    // And the parameterised one they must outrank still exists.
    expect(paths).toContain('Get /bookings/:id');
  });
});

describe('the shadowing rule itself', () => {
  it('catches the case that started this', () => {
    expect(shadows('bookings/:id', 'bookings/settings')).toBe(true);
  });

  it('does not fire across different depths', () => {
    expect(shadows('bookings/:id', 'bookings/a/b')).toBe(false);
    expect(shadows('bookings/:id/occurrences', 'bookings/settings')).toBe(
      false,
    );
  });

  it('does not fire across different bases', () => {
    expect(shadows('series/:id', 'bookings/settings')).toBe(false);
  });

  it('fires at depth, not just at the root', () => {
    expect(shadows('series/:id/:thing', 'series/abc/occurrences')).toBe(true);
  });

  it('leaves two literals alone', () => {
    expect(shadows('bookings/catalogue', 'bookings/settings')).toBe(false);
  });
});
