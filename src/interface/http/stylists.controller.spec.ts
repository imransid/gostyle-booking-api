import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StylistsController } from './stylists.controller';
import type { StylistHandler } from '@application/queries/stylist.handler';
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
  'stylists.controller.ts',
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

  create(...args: readonly unknown[]) {
    this.record('create', args);
    return Promise.resolve({} as never);
  }
  list(...args: readonly unknown[]) {
    this.record('list', args);
    return Promise.resolve([] as never);
  }
  findOne(...args: readonly unknown[]) {
    this.record('findOne', args);
    return Promise.resolve({} as never);
  }
  update(...args: readonly unknown[]) {
    this.record('update', args);
    return Promise.resolve({} as never);
  }
  remove(...args: readonly unknown[]) {
    this.record('remove', args);
    return Promise.resolve({} as never);
  }
}

let fake: FakeHandler;
let controller: StylistsController;

beforeEach(() => {
  fake = new FakeHandler();
  controller = new StylistsController(fake as unknown as StylistHandler);
});

describe('passing the request on', () => {
  it('sends the acting user, never a value from the body', async () => {
    await controller.create({ branchId: 'marina-walk', label: 'hello' }, ACTOR);
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
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const VALIDATOR =
  /@(Is[A-Z]\w*|Matches|Min|Max|MinLength|MaxLength|Length|Allow|Type|ValidateNested|WireEnum|ArrayMinSize|ArrayMaxSize)\b/;

describe('the DTOs in this file', () => {
  const src = stripComments(readFileSync(SOURCE, 'utf8'));

  const blocks = [...src.matchAll(/export class (\w+Dto)\s*\{([\s\S]*?)\n\}/g)];

  it('finds the DTO classes to check', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  for (const block of blocks) {
    const name = block[1]!;
    const body = block[2]!;

    it(name + ': every property carries a class-validator decorator', () => {
      const bad: string[] = [];

      for (const chunk of body.split(/\n\s*\n/)) {
        const prop = /^\s*(\w+)[!?]\s*:/m.exec(chunk);
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
      const bad = [...body.matchAll(/^\s*(\w*[Ii]d)\s*=\s*/gm)].map(
        (m) => m[1],
      );
      expect(bad).toEqual([]);
    });
  }
});
