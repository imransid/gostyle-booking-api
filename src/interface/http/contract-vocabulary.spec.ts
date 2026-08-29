import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Request DTOs must speak the front end's vocabulary, not the diary's.
 *
 * The wire contract is `serviceIds`, not `services`, and SCREAMING_SNAKE for
 * every enum a caller sends. Responses were converted in e856885 and 5db4141;
 * requests drifted anyway, one DTO at a time, and the drift is invisible
 * until a front end built against the contract sends `serviceIds` to an
 * endpoint expecting `services` and gets a 400 listing a field it has never
 * heard of.
 *
 * PRE-CONTRACT ENDPOINTS ARE LISTED, NOT EXEMPTED. The three below shipped
 * before the contract existed and something may already call them, so
 * changing them is a breaking change and a decision rather than a cleanup.
 * They are named here so the debt is visible and countable instead of
 * quietly tolerated -- and so the day they are converted, deleting a line
 * here is the whole change.
 */

const HTTP = join(process.cwd(), 'src', 'interface', 'http');

/** Shipped before the wire contract. Converting them breaks live callers. */
const PRE_CONTRACT = new Set([
  'availability.controller.ts',
  'holds.controller.ts',
  'bookings.controller.ts',
]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const files = readdirSync(HTTP).filter((f) => f.endsWith('.controller.ts'));
const contractFiles = files.filter((f) => !PRE_CONTRACT.has(f));

describe('request DTO vocabulary', () => {
  it('has controllers to check, and the exemption list is not the whole set', () => {
    expect(contractFiles.length).toBeGreaterThan(5);
  });

  for (const file of contractFiles) {
    it(`${file}: names the field serviceIds, never services`, () => {
      const src = stripComments(readFileSync(join(HTTP, file), 'utf8'));
      const bad: string[] = [];
      src.split('\n').forEach((line, i) => {
        // A DTO property declaration, not a mapping to an inner name.
        if (/^\s*services[!?]?\s*:/.test(line)) {
          bad.push(
            `line ${i + 1}: ${line.trim()} -- the contract says serviceIds`,
          );
        }
      });
      expect(bad).toEqual([]);
    });

    it(`${file}: request enums are SCREAMING_SNAKE`, () => {
      const src = stripComments(readFileSync(join(HTTP, file), 'utf8'));
      const bad: string[] = [];
      // @IsIn([...]) is the request side. Anything lowercase in one is a
      // domain word that never got shouted.
      for (const m of src.matchAll(/@IsIn\(\s*\[([^\]]*)\]/g)) {
        const values = m[1]!
          .split(',')
          .map((v) => v.trim().replace(/^'|'$/g, ''))
          .filter((v) => v.length > 0 && !v.startsWith('.'));
        const lower = values.filter((v) => /^[a-z][a-z_]*$/.test(v));
        if (lower.length > 0) {
          const line = src.slice(0, m.index).split('\n').length;
          bad.push(`line ${line}: @IsIn([${lower.join(', ')}]) -- shout these`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('the pre-contract debt', () => {
  it('is exactly the three endpoints that shipped before the contract', () => {
    // If this fails because the set shrank, delete the name from PRE_CONTRACT
    // -- the endpoint has been converted and should be guarded like the rest.
    expect([...PRE_CONTRACT].sort()).toEqual([
      'availability.controller.ts',
      'bookings.controller.ts',
      'holds.controller.ts',
    ]);
    for (const f of PRE_CONTRACT) expect(files).toContain(f);
  });

  it('is still real, so the list stays honest', () => {
    // Each listed file genuinely still has the drift. A file that no longer
    // does should leave the list rather than sit here forgiven.
    const drifted = [...PRE_CONTRACT].filter((f) => {
      const src = stripComments(readFileSync(join(HTTP, f), 'utf8'));
      return (
        /^\s*services[!?]?\s*:/m.test(src) || /@IsIn\(\s*\[\s*'[a-z]/.test(src)
      );
    });
    expect(drifted.sort()).toEqual([...PRE_CONTRACT].sort());
  });
});
