import { describe, it, expect } from 'vitest';
import {
  cleanStylistLabel,
  mayModifyStylist,
  MAX_STYLIST_LABEL,
  type ModifyRequest,
} from './stylist';

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

describe('tidying a stylist label', () => {
  it('trims the edges', () => {
    expect(cleanStylistLabel('  hello  ')).toEqual({
      kind: 'ok',
      label: 'hello',
    });
  });

  it('refuses text that is only whitespace', () => {
    expect(cleanStylistLabel('   ').kind).toBe('refused');
  });

  it('refuses text past the limit', () => {
    const long = 'x'.repeat(MAX_STYLIST_LABEL + 1);
    expect(cleanStylistLabel(long).kind).toBe('refused');
  });

  it('accepts text exactly at the limit', () => {
    const exact = 'x'.repeat(MAX_STYLIST_LABEL);
    expect(cleanStylistLabel(exact).kind).toBe('ok');
  });

  it('measures the length AFTER trimming', () => {
    const padded = '  ' + 'x'.repeat(MAX_STYLIST_LABEL) + '  ';
    expect(cleanStylistLabel(padded).kind).toBe('ok');
  });

  it('always gives a reason a client can show the user', () => {
    const d = cleanStylistLabel('');
    if (d.kind !== 'refused') throw new Error('expected a refusal');
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe('who may change a stylist', () => {
  const base: ModifyRequest = {
    authorId: 'maya',
    actorId: 'maya',
    actorKind: 'staff',
  };

  it('lets the author change their own', () => {
    expect(mayModifyStylist(base).kind).toBe('allowed');
  });

  it('lets a manager change anyone', () => {
    const d = mayModifyStylist({
      ...base,
      actorId: 'rana',
      actorKind: 'manager',
    });
    expect(d.kind).toBe('allowed');
  });

  it('refuses a different staff member', () => {
    expect(mayModifyStylist({ ...base, actorId: 'sara' }).kind).toBe('refused');
  });

  it('refuses a customer', () => {
    const d = mayModifyStylist({
      ...base,
      actorId: 'dana',
      actorKind: 'customer',
    });
    expect(d.kind).toBe('refused');
  });
});

describe('invariants', () => {
  it('never returns ok with untrimmed text', () => {
    const samples = ['a', ' a', 'a ', '  a  ', 'a b', '\ta\n'];
    for (const s of samples) {
      const r = cleanStylistLabel(s);
      if (r.kind !== 'ok') continue;
      expect(r.label).toBe(r.label.trim());
    }
  });

  it('a manager is never refused, whoever wrote it', () => {
    for (const author of ['maya', 'sara', 'dana', 'rana']) {
      const d = mayModifyStylist({
        authorId: author,
        actorId: 'rana',
        actorKind: 'manager',
      });
      expect(d.kind).toBe('allowed');
    }
  });
});
