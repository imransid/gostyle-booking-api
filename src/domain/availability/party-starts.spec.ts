import { describe, it, expect } from 'vitest';
import { planParty, type PartyContext, type PartyParticipant } from './party';
import {
  MAX_PARTY_STARTS,
  halfHourStarts,
  planPartyAtEach,
} from './party-starts';

const person = (
  id: string,
  over: Partial<PartyParticipant> = {},
): PartyParticipant => ({
  id,
  label: id,
  skills: ['hair'],
  durationMin: 60,
  resourceType: 'styling',
  preferredStaffId: null,
  ...over,
});

const pro = (
  id: string,
  skills: string[],
  busy: { fromMin: number; toMin: number }[] = [],
) => ({ id, name: id, skills, atCap: false, busy });

/** A day where the answer changes with the hour. */
function day(): PartyContext {
  return {
    professionals: [
      pro('maya', ['hair', 'color'], [{ fromMin: 660, toMin: 780 }]),
      pro('anya', ['hair', 'color'], [{ fromMin: 900, toMin: 1080 }]),
      pro('reem', ['hair'], [{ fromMin: 720, toMin: 840 }]),
      pro('lina', ['nails'], [{ fromMin: 780, toMin: 900 }]),
    ],
    resourceCounts: { styling: 3, color: 2, nails: 1 },
    occupied: [{ resourceType: 'styling', fromMin: 720, toMin: 780 }],
  };
}

const party = [
  person('a'),
  person('b', { durationMin: 90 }),
  person('c', { skills: ['nails'], resourceType: 'nails' }),
];

/** Freeze all the way down, so any write to the context throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('planning one party at many starts', () => {
  it('answers each start exactly as planParty does alone', () => {
    const starts = halfHourStarts();
    const each = planPartyAtEach(party, starts, 'arrive_together', day());

    expect(each).toEqual(
      starts.map((s) => planParty(party, s, 'arrive_together', day())),
    );
  });

  it('means it: the same starts give both answers across the day', () => {
    // A context where every start fits, or none does, would make the test
    // above pass for a function that ignored the start entirely.
    const kinds = planPartyAtEach(
      party,
      halfHourStarts(),
      'arrive_together',
      day(),
    ).map((p) => p.kind);
    expect(new Set(kinds)).toEqual(new Set(['planned', 'infeasible']));
  });

  it('keeps the order asked, repeats included', () => {
    const starts = [1000, 600, 1000, 780, 605];
    const each = planPartyAtEach(party, starts, 'arrive_together', day());

    expect(each).toHaveLength(starts.length);
    expect(each).toEqual(
      starts.map((s) => planParty(party, s, 'arrive_together', day())),
    );
  });

  it('passes the options through, as the single call does', () => {
    const options = { finishWindowMin: 15, maxStaggerMin: 30 };
    const starts = [660, 900, 1200];
    expect(
      planPartyAtEach(party, starts, 'finish_together', day(), options),
    ).toEqual(
      starts.map((s) => planParty(party, s, 'finish_together', day(), options)),
    );
  });

  it('never writes to the context, so every start sees the same day', () => {
    const frozen = deepFreeze(day());
    expect(() =>
      planPartyAtEach(party, halfHourStarts(), 'arrive_together', frozen),
    ).not.toThrow();
    expect(frozen).toEqual(day());
  });

  it('asks nothing of an empty list', () => {
    expect(planPartyAtEach(party, [], 'arrive_together', day())).toEqual([]);
  });
});

describe('the cap', () => {
  it('is the engine day at half-hour steps, and no more', () => {
    const starts = halfHourStarts();
    expect(starts[0]).toBe(600);
    expect(starts.at(-1)).toBe(1290);
    expect(MAX_PARTY_STARTS).toBe(starts.length);
  });
});
