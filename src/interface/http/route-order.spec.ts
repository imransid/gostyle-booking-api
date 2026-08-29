import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A parameterised route shadows every literal declared after it.
 *
 * Express matches in declaration order, so `@Get(':id')` above
 * `@Get('settings')` means GET /settings never reaches its handler: it
 * arrives as id = "settings" instead. The failure is quiet — the wrong
 * handler runs and answers plausibly — which is why this is a test rather
 * than a note in a review checklist.
 *
 * Read from the SOURCE rather than from a booted app on purpose: this has to
 * fail on the pull request that introduces it, not on the first request in
 * production that happens to hit the shadowed path.
 */

// From the working directory, not import.meta: tsc checks this file under
// module: commonjs, where import.meta is a compile error, and a spec that
// fails the typecheck fails CI whatever vitest thinks of it.
const DIR = join(process.cwd(), 'src', 'interface', 'http');

interface Route {
  readonly method: string;
  readonly path: string;
  readonly line: number;
}

function routesOf(source: string): Route[] {
  const out: Route[] = [];
  source.split('\n').forEach((text, i) => {
    const m = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(text);
    if (m !== null) {
      out.push({ method: m[1]!, path: m[2] ?? '', line: i + 1 });
    }
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

const controllers = readdirSync(DIR).filter((f) =>
  f.endsWith('.controller.ts'),
);

describe('route declaration order', () => {
  it('finds the controllers', () => {
    expect(controllers.length).toBeGreaterThan(10);
  });

  for (const file of controllers) {
    it(`${file}: no literal route is shadowed by an earlier parameter`, () => {
      const routes = routesOf(readFileSync(join(DIR, file), 'utf8'));
      const problems: string[] = [];

      routes.forEach((later, j) => {
        if (later.path.includes(':')) return; // only literals can be shadowed
        routes.slice(0, j).forEach((earlier) => {
          if (earlier.method !== later.method) return;
          if (!earlier.path.includes(':')) return;
          if (shadows(earlier.path, later.path)) {
            problems.push(
              `@${later.method}('${later.path}') on line ${later.line} is ` +
                `unreachable: @${earlier.method}('${earlier.path}') on line ` +
                `${earlier.line} matches it first. Move the literal above it.`,
            );
          }
        });
      });

      expect(problems).toEqual([]);
    });
  }
});

describe('the shadowing rule itself', () => {
  it('catches the case that started this', () => {
    expect(shadows(':id', 'settings')).toBe(true);
  });

  it('does not fire across different depths', () => {
    expect(shadows(':id', 'a/b')).toBe(false);
    expect(shadows(':id/occurrences', 'settings')).toBe(false);
  });

  it('fires at depth, not just at the root', () => {
    expect(shadows(':id/:thing', 'abc/occurrences')).toBe(true);
    expect(shadows(':id/occurrences', 'abc/occurrences')).toBe(true);
  });

  it('leaves two literals alone', () => {
    expect(shadows('catalogue', 'settings')).toBe(false);
  });
});
