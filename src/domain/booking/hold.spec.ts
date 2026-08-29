import { describe, it, expect } from 'vitest';
import {
  feasibilityToken,
  tokenMatches,
  judgeToken,
  startHold,
  isAlive,
  remainingMs,
  remainingSeconds,
  isUrgent,
  extendOnce,
  formatCountdown,
  captureGate,
  describeRefusal,
  HOLD_TTL_MS,
  THREE_DS_GRACE_MS,
  URGENT_THRESHOLD_MS,
  type AttendedInterval,
  type HoldClock,
} from './hold';

const T0 = 1_700_000_000_000; // a fixed epoch, so no test depends on the wall clock

function iv(
  staffId: string,
  startMin: number,
  endMin: number,
  status = 'confirmed',
): AttendedInterval {
  return { staffId, startMin, endMin, status };
}

const DIARY: AttendedInterval[] = [
  iv('maya', 900, 1005),
  iv('anya', 660, 785),
  iv('reem', 780, 825),
];

describe('the feasibility token', () => {
  it('the same world produces the same token', () => {
    expect(feasibilityToken(DIARY)).toBe(feasibilityToken([...DIARY]));
  });

  it('row order does not matter', () => {
    const shuffled = [DIARY[2]!, DIARY[0]!, DIARY[1]!];
    expect(feasibilityToken(shuffled)).toBe(feasibilityToken(DIARY));
  });

  it('an empty calendar has a stable token', () => {
    expect(feasibilityToken([])).toBe(feasibilityToken([]));
    expect(feasibilityToken([])).not.toBe(feasibilityToken(DIARY));
  });

  it('THE ABA PROBLEM: one cancelled, one created, count unchanged', () => {
    const before = [iv('maya', 900, 1005), iv('anya', 660, 785)];
    // Anya's booking is cancelled and Reem takes a different slot instead.
    const after = [iv('maya', 900, 1005), iv('reem', 1100, 1160)];

    expect(after).toHaveLength(before.length); // a count would see nothing
    expect(feasibilityToken(after)).not.toBe(feasibilityToken(before));
  });

  it('a booking moving by five minutes changes the token', () => {
    const moved = [iv('maya', 905, 1010), DIARY[1]!, DIARY[2]!];
    expect(feasibilityToken(moved)).not.toBe(feasibilityToken(DIARY));
  });

  it('a status change changes the token, because it changes what blocks', () => {
    const cancelled = [
      iv('maya', 900, 1005, 'cancelled'),
      DIARY[1]!,
      DIARY[2]!,
    ];
    expect(feasibilityToken(cancelled)).not.toBe(feasibilityToken(DIARY));
  });

  it('the same slot on a different professional is a different world', () => {
    expect(feasibilityToken([iv('maya', 900, 1005)])).not.toBe(
      feasibilityToken([iv('anya', 900, 1005)]),
    );
  });

  it('an added booking changes the token', () => {
    expect(feasibilityToken([...DIARY, iv('lina', 1200, 1260)])).not.toBe(
      feasibilityToken(DIARY),
    );
  });

  it('tokenMatches is a plain equality, no fuzziness', () => {
    expect(tokenMatches(feasibilityToken(DIARY), feasibilityToken(DIARY))).toBe(
      true,
    );
    expect(tokenMatches(feasibilityToken(DIARY), feasibilityToken([]))).toBe(
      false,
    );
  });

  it('collides on nothing across 2000 random diaries', () => {
    const seen = new Map<string, string>();
    for (let t = 0; t < 2000; t++) {
      const n = 1 + Math.floor(Math.random() * 8);
      const rows: AttendedInterval[] = [];
      for (let i = 0; i < n; i++) {
        const start = 600 + 5 * Math.floor(Math.random() * 140);
        rows.push(
          iv(
            ['maya', 'anya', 'reem', 'lina'][Math.floor(Math.random() * 4)]!,
            start,
            start + 5 * (1 + Math.floor(Math.random() * 24)),
          ),
        );
      }
      const canonical = [...rows]
        .map((r) => `${r.staffId}|${r.startMin}|${r.endMin}|${r.status}`)
        .sort()
        .join(';');
      const token = feasibilityToken(rows);
      const previous = seen.get(token);
      if (previous !== undefined) expect(previous).toBe(canonical);
      seen.set(token, canonical);
    }
  });
});

describe('the token never refuses on its own', () => {
  const a = feasibilityToken(DIARY);
  const b = feasibilityToken([...DIARY, iv('lina', 1200, 1260)]);

  it('unchanged world, feasible slot: proceed quietly', () => {
    expect(judgeToken(a, a, true)).toEqual({ kind: 'unchanged' });
  });

  it('CHANGED world, still feasible: re-stamp and inform, do NOT refuse', () => {
    expect(judgeToken(a, b, true)).toEqual({
      kind: 'moved_but_still_feasible',
      freshToken: b,
    });
  });

  it('slot genuinely gone: that is the real conflict', () => {
    expect(judgeToken(a, b, false)).toEqual({ kind: 'no_longer_feasible' });
  });

  it('an unchanged token with an infeasible slot still refuses', () => {
    // Feasibility decides, not the digest.
    expect(judgeToken(a, a, false)).toEqual({ kind: 'no_longer_feasible' });
  });
});

describe('the hold clock', () => {
  const hold = startHold(T0);

  it('a fresh hold runs for ten minutes', () => {
    expect(hold.expiresAtMs - T0).toBe(HOLD_TTL_MS);
    expect(hold.extended).toBe(false);
  });

  it('is alive right up to the boundary, and dead at it', () => {
    expect(isAlive(hold, T0 + HOLD_TTL_MS - 1)).toBe(true);
    expect(isAlive(hold, T0 + HOLD_TTL_MS)).toBe(false);
    expect(isAlive(hold, T0 + HOLD_TTL_MS + 1)).toBe(false);
  });

  it('counts down and floors at zero', () => {
    expect(remainingMs(hold, T0)).toBe(HOLD_TTL_MS);
    expect(remainingMs(hold, T0 + 60_000)).toBe(HOLD_TTL_MS - 60_000);
    expect(remainingMs(hold, T0 + HOLD_TTL_MS + 99_999)).toBe(0);
  });

  it('turns urgent under one minute, and stops being urgent when dead', () => {
    expect(isUrgent(hold, T0)).toBe(false);
    expect(isUrgent(hold, T0 + HOLD_TTL_MS - URGENT_THRESHOLD_MS)).toBe(true);
    expect(isUrgent(hold, T0 + HOLD_TTL_MS - 1)).toBe(true);
    expect(isUrgent(hold, T0 + HOLD_TTL_MS)).toBe(false);
  });

  it('renders the countdown the wizard shows', () => {
    // Derived from the constant, not written out: the TTL has already moved
    // once (ten minutes to fifteen) and a hand-typed "10:00" is exactly the
    // thing that then fails for the wrong reason.
    const mins = HOLD_TTL_MS / 60_000;
    expect(formatCountdown(hold, T0)).toBe(`${mins}:00`);
    expect(formatCountdown(hold, T0 + HOLD_TTL_MS - 45_000)).toBe('0:45');
    expect(formatCountdown(hold, T0 + HOLD_TTL_MS)).toBe('0:00');
  });

  it('a demo-fast TTL is just a different number', () => {
    const fast = startHold(T0, 75_000);
    expect(formatCountdown(fast, T0)).toBe('1:15');
  });

  it('remainingSeconds rounds up, so 0:01 never displays as 0:00 early', () => {
    expect(remainingSeconds(hold, T0 + HOLD_TTL_MS - 1)).toBe(1);
  });
});

describe('exactly one silent extension, and only while alive', () => {
  it('a 3-D Secure challenge buys five more minutes', () => {
    const hold = startHold(T0);
    const extended = extendOnce(hold, T0 + 60_000);
    expect(extended?.expiresAtMs).toBe(T0 + HOLD_TTL_MS + THREE_DS_GRACE_MS);
    expect(extended?.extended).toBe(true);
  });

  it('a second extension is refused, or a failing customer holds the slot forever', () => {
    const once = extendOnce(startHold(T0), T0 + 60_000);
    expect(once).not.toBeNull();
    expect(extendOnce(once!, T0 + 120_000)).toBeNull();
  });

  it('a dead hold cannot be revived, because the capacity is already gone', () => {
    expect(extendOnce(startHold(T0), T0 + HOLD_TTL_MS)).toBeNull();
  });

  it('the extension is measured from the original expiry, not from now', () => {
    const hold = startHold(T0);
    const extended = extendOnce(hold, T0 + 9 * 60_000);
    expect(extended?.expiresAtMs).toBe(hold.expiresAtMs + THREE_DS_GRACE_MS);
  });
});

describe('the four checks before a charge', () => {
  const alive: HoldClock = startHold(T0);
  const token = feasibilityToken(DIARY);

  function gate(over: Partial<Parameters<typeof captureGate>[0]> = {}) {
    return captureGate({
      hold: alive,
      nowMs: T0 + 60_000,
      revokedSkills: [],
      stillFeasible: true,
      stampedToken: token,
      freshToken: token,
      ...over,
    });
  }

  it('all clear, nothing to say', () => {
    expect(gate()).toEqual({ kind: 'proceed' });
  });

  it('a dead hold is refused BEFORE anything else runs', () => {
    const g = gate({
      nowMs: T0 + HOLD_TTL_MS,
      revokedSkills: ['color'],
      stillFeasible: false,
    });
    // Everything else is also wrong, but this is the message that matters.
    expect(g).toEqual({ kind: 'refuse', reason: { kind: 'hold_expired' } });
  });

  it('a revoked certification names the skill', () => {
    expect(gate({ revokedSkills: ['color'] })).toEqual({
      kind: 'refuse',
      reason: { kind: 'skill_revoked', skills: ['color'] },
    });
  });

  it('a taken slot is refused, and nothing is charged', () => {
    expect(gate({ stillFeasible: false })).toEqual({
      kind: 'refuse',
      reason: { kind: 'slot_taken' },
    });
  });

  it('a moved calendar with a surviving slot PROCEEDS, and re-stamps', () => {
    const fresh = feasibilityToken([...DIARY, iv('lina', 1200, 1260)]);
    expect(gate({ freshToken: fresh })).toEqual({
      kind: 'proceed',
      reStampToken: fresh,
    });
  });

  it('skills are checked before feasibility, because they are cheaper', () => {
    const g = gate({ revokedSkills: ['color'], stillFeasible: false });
    expect(g).toEqual({
      kind: 'refuse',
      reason: { kind: 'skill_revoked', skills: ['color'] },
    });
  });

  it('every refusal has an operator message that says nothing was charged', () => {
    expect(describeRefusal({ kind: 'hold_expired' })).toContain('never taken');
    expect(describeRefusal({ kind: 'slot_taken' })).toContain(
      'Nothing was charged',
    );
    expect(
      describeRefusal({ kind: 'skill_revoked', skills: ['color'] }),
    ).toContain('nothing was charged');
  });
});
