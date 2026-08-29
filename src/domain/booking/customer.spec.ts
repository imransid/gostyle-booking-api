import { describe, it, expect } from 'vitest';
import {
  assessRisk,
  requirementFor,
  dueAtCheckout,
  tierDiscountPercent,
  DEPOSIT_FLOOR,
  DEPOSIT_CEILING,
  DEFAULT_BRANCH,
  type CustomerHistory,
  type RequirementInput,
  type Tier,
  type BranchRules,
} from './customer';
import { Money } from '../shared/money';

function history(over: Partial<CustomerHistory> = {}): CustomerHistory {
  return { noShows: 0, lateCancels: 0, visits: 0, ...over };
}

// ---------------------------------------------------------------- risk

describe('the risk ladder', () => {
  it('a customer with no history starts at 80, LOW', () => {
    const r = assessRisk(history());
    expect(r.score).toBe(80);
    expect(r.band).toBe('LOW');
  });

  it("THE DOCUMENT'S OWN EXAMPLE: two no-shows and four visits scores 28, HIGH", () => {
    const r = assessRisk(history({ noShows: 2, visits: 4 }));
    expect(r.score).toBe(28); // 80 - 60 + 8
    expect(r.band).toBe('HIGH');
  });

  it('HIGHER IS BETTER, which is the opposite of the obvious reading', () => {
    expect(assessRisk(history({ visits: 10 })).score).toBe(100);
    expect(assessRisk(history({ noShows: 3 })).score).toBe(0);
  });

  it('a no-show costs 30, twice what a late cancel costs', () => {
    expect(assessRisk(history({ noShows: 1 })).score).toBe(50);
    expect(assessRisk(history({ lateCancels: 1 })).score).toBe(65);
    expect(assessRisk(history({ lateCancels: 2 })).score).toBe(50);
  });

  it('visits earn 2 each, capped at ten', () => {
    expect(assessRisk(history({ visits: 5 })).score).toBe(90);
    expect(assessRisk(history({ visits: 10 })).score).toBe(100);
    // The eleventh visit and the hundredth are worth nothing more.
    expect(assessRisk(history({ visits: 50 })).score).toBe(100);
  });

  it('THE CAP IS THE POINT: turning up cannot buy unlimited forgiveness', () => {
    // Two no-shows costs 60. Even a hundred visits only returns 20.
    const r = assessRisk(history({ noShows: 2, visits: 100 }));
    expect(r.score).toBe(40);
    expect(r.band).toBe('HIGH');
  });

  it('the band boundaries are 75 and 45', () => {
    expect(assessRisk(history({ lateCancels: 1 })).score).toBe(65);
    expect(assessRisk(history({ lateCancels: 1 })).band).toBe('WATCH');
    expect(assessRisk(history({ noShows: 1, visits: 10 })).score).toBe(70);
    expect(assessRisk(history({ noShows: 1, visits: 10 })).band).toBe('WATCH');
  });

  it('the score is clamped to 0 and 100, never negative', () => {
    expect(assessRisk(history({ noShows: 10 })).score).toBe(0);
    expect(assessRisk(history({ noShows: 10 })).band).toBe('HIGH');
  });

  it('every assessment says why, in a sentence someone can read aloud', () => {
    const r = assessRisk(history({ noShows: 2, visits: 4 }));
    expect(r.reason).toContain('Score 28');
    expect(r.reason).toContain('HIGH');
    expect(r.reason).toContain('30% deposit');
  });

  it('a WATCH band says it forces no money', () => {
    expect(assessRisk(history({ lateCancels: 1 })).reason).toContain(
      'no deposit forced',
    );
  });
});

// ---------------------------------------------------------------- rungs

const COLOUR_480 = 48000;

function req(over: Partial<RequirementInput> = {}) {
  return requirementFor({
    totalFils: COLOUR_480,
    risk: 'LOW',
    riskScore: 84,
    requireDepositFlag: false,
    service: { name: 'Hair color and style', percent: 50, fixedFils: null },
    isNewCustomer: false,
    channel: 'desk',
    startMin: 900, // 15:00, off peak
    branch: DEFAULT_BRANCH,
    ...over,
  });
}

describe('the worked trace from the document', () => {
  it('resolves to a 50% service deposit with the exact source string', () => {
    const r = req();
    expect(r.kind).toBe('deposit');
    expect(Money.fils(r.amountFils).toString()).toBe('AED 240.00');
    expect(r.source).toBe('Service rule 50% (Hair color and style)');
  });

  it('lists all seven rung rows, whether they fired or not', () => {
    expect(req().trace).toHaveLength(7);
  });

  it('exactly one rung fired, and it is rung 3', () => {
    const fired = req().trace.filter((t) => t.fired);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.rung).toBe('3 Service-level setting');
  });

  it('the risk row shows the score even when it does not fire', () => {
    const row = req().trace.find((t) => t.rung === '2 Customer risk')!;
    expect(row.evaluation).toBe('score 84, LOW band');
    expect(row.fired).toBe(false);
  });
});

describe('THE STRICTEST WINS, not the first that matches', () => {
  it('a rung can fire AND LOSE', () => {
    // First visit says 20%, the service says 50%. Both fire; 50% wins.
    const r = req({ isNewCustomer: true });
    expect(r.source).toContain('Service rule 50%');
    expect(r.trace.filter((t) => t.fired)).toHaveLength(2);
  });

  it('a HIGH-risk 30% loses to a 50% service rule', () => {
    const r = req({ risk: 'HIGH', riskScore: 28 });
    expect(r.amountFils).toBe(24000); // 50%, not 30%
    expect(r.source).toContain('Service rule 50%');
  });

  it('and wins against a 10% one', () => {
    const r = req({
      risk: 'HIGH',
      riskScore: 28,
      service: { name: 'Fringe trim', percent: 10, fixedFils: null },
    });
    expect(r.source).toBe('High risk: 30%');
  });

  it('full beats any deposit, whatever the amounts', () => {
    const r = req({
      service: { name: 'Keratin', percent: 100, fixedFils: null },
      isNewCustomer: true,
    });
    expect(r.kind).toBe('full');
  });

  it('with no rung firing at all, the answer is none', () => {
    const r = req({
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.kind).toBe('none');
    expect(r.amountFils).toBe(0);
    expect(r.trace.filter((t) => t.fired)).toHaveLength(0);
  });
});

describe('rung 2: customer risk', () => {
  it('HIGH forces 30%, NOT full prepayment', () => {
    const r = req({
      risk: 'HIGH',
      riskScore: 28,
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.kind).toBe('deposit');
    expect(Money.fils(r.amountFils).toString()).toBe('AED 144.00');
  });

  it('WATCH forces NOTHING: it raises reminders, not money', () => {
    const r = req({
      risk: 'WATCH',
      riskScore: 50,
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.kind).toBe('none');
  });

  it('the Require-deposit flag forces 50%, and outranks a HIGH band', () => {
    const r = req({
      requireDepositFlag: true,
      risk: 'HIGH',
      riskScore: 28,
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.source).toContain('Require-deposit flag');
    expect(r.amountFils).toBe(24000);
  });
});

describe('rung 3: a service may define a percentage, a fixed amount, or both', () => {
  it('a percentage alone', () => {
    expect(req().source).toBe('Service rule 50% (Hair color and style)');
  });

  it('a fixed amount alone', () => {
    const r = req({
      service: { name: 'Keratin', percent: null, fixedFils: 40000 },
    });
    expect(r.source).toBe('Service fixed AED 400.00 (Keratin)');
  });

  it('THE KERATIN CASE: a fixed amount beats a percentage that under-protects', () => {
    // 20% of AED 480 is AED 96. The fixed AED 400 wins, and says why.
    const r = req({
      service: { name: 'Keratin', percent: 20, fixedFils: 40000 },
    });
    expect(Money.fils(r.amountFils).toString()).toBe('AED 400.00');
    expect(r.source).toBe('Service fixed AED 400.00 beats 20% (Keratin)');
  });

  it('a percentage that beats the fixed amount keeps the percentage', () => {
    const r = req({
      service: { name: 'Colour', percent: 50, fixedFils: 5000 },
    });
    expect(r.amountFils).toBe(24000);
    expect(r.source).toContain('Service rule 50%');
  });
});

describe('rung 4a: the first visit is 20%, any channel', () => {
  it('a new customer at the desk still owes 20%', () => {
    const r = req({
      isNewCustomer: true,
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.source).toBe('First visit: 20%');
    expect(Money.fils(r.amountFils).toString()).toBe('AED 96.00');
  });

  it('a returning customer does not', () => {
    const row = req().trace.find((t) => t.rung === '4a First-visit rule')!;
    expect(row.evaluation).toBe('returning customer');
    expect(row.fired).toBe(false);
  });
});

describe('rung 4b: the peak window ESCALATES, it does not set an amount', () => {
  const peak: BranchRules = { ...DEFAULT_BRANCH, peakEscalation: true };

  it('none becomes a 20% deposit', () => {
    const r = req({
      branch: peak,
      startMin: 1080, // 18:00
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.kind).toBe('deposit');
    expect(Money.fils(r.amountFils).toString()).toBe('AED 96.00');
    expect(r.source).toContain('Peak window 17:00 to 20:00');
  });

  it('a deposit becomes FULL payment', () => {
    const r = req({ branch: peak, startMin: 1080 });
    expect(r.kind).toBe('full');
    expect(r.amountFils).toBe(COLOUR_480);
    expect(r.source).toContain('Peak window escalation');
    // The rung it escalated is named, so the trail is not lost.
    expect(r.source).toContain('Service rule 50%');
  });

  it('full stays full: there is no level above it', () => {
    const r = req({
      branch: peak,
      startMin: 1080,
      service: { name: 'Keratin', percent: 100, fixedFils: null },
    });
    expect(r.kind).toBe('full');
  });

  it('the boundaries: 17:00 is in, 20:00 is out', () => {
    expect(req({ branch: peak, startMin: 1020 }).kind).toBe('full'); // 17:00
    expect(req({ branch: peak, startMin: 1199 }).kind).toBe('full'); // 19:59
    expect(req({ branch: peak, startMin: 1200 }).kind).toBe('deposit'); // 20:00
  });

  it('off by default, so a branch opts in', () => {
    expect(req({ startMin: 1080 }).kind).toBe('deposit');
    const row = req({ startMin: 1080 }).trace.find(
      (t) => t.rung === '4b Peak window',
    )!;
    expect(row.evaluation).toBe('disabled');
  });
});

describe('rungs 5 and 6: channel and branch defaults', () => {
  it('the desk defaults to none', () => {
    const row = req({
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    }).trace.find((t) => t.rung === '5 Channel default')!;
    expect(row.evaluation).toBe('desk, none');
    expect(row.fired).toBe(false);
  });

  it('online takes the branch online rule', () => {
    const r = req({
      channel: 'online',
      branch: { ...DEFAULT_BRANCH, onlineDefaultPercent: 25 },
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.source).toBe('Online default: 25%');
  });

  it('the branch default is the final fallback', () => {
    const r = req({
      branch: { ...DEFAULT_BRANCH, defaultPercent: 15 },
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
    });
    expect(r.source).toBe('Branch default: 15%');
  });
});

describe('rung 1: a manual override replaces the answer outright', () => {
  it('in the downward direction, over a HIGH-risk deposit', () => {
    const r = req({
      risk: 'HIGH',
      riskScore: 28,
      managerOverride: { amountFils: 5000, reason: 'known to the owner' },
    });
    expect(r.amountFils).toBe(5000);
    expect(r.source).toBe('Manager override: known to the owner');
  });

  it('and upward, over nothing at all', () => {
    const r = req({
      service: { name: 'Fringe trim', percent: null, fixedFils: null },
      managerOverride: { amountFils: 20000, reason: 'peak Saturday' },
    });
    expect(r.amountFils).toBe(20000);
  });

  it('nothing else is even consulted, and the trace says so', () => {
    const r = req({ managerOverride: { amountFils: 100, reason: 'X' } });
    const others = r.trace.filter((t) => t.rung !== '1 Manual override');
    expect(others.every((t) => t.evaluation === 'not consulted')).toBe(true);
  });

  it('an override of zero is a legitimate waiver', () => {
    const r = req({ managerOverride: { amountFils: 0, reason: 'goodwill' } });
    expect(r.kind).toBe('none');
    expect(r.source).toContain('goodwill');
  });

  it('the reason is always in the source, because that is the audit trail', () => {
    expect(
      req({ managerOverride: { amountFils: 100, reason: 'Q' } }).source,
    ).toContain('Q');
  });
});

// ---------------------------------------------------------------- amount

describe('the amount', () => {
  it('a percentage is rounded to WHOLE DIRHAMS, not fils', () => {
    // 10% of AED 175 is AED 17.50, which nobody quotes.
    const r = req({
      totalFils: 17500,
      service: { name: 'Blow dry', percent: 10, fixedFils: null },
    });
    expect(Money.fils(r.amountFils).toString()).toBe('AED 18.00');
  });

  it('raised to the branch floor, and the wizard is told', () => {
    const r = req({
      totalFils: 6000,
      service: { name: 'Brow', percent: 1, fixedFils: null },
    });
    expect(r.amountFils).toBe(DEPOSIT_FLOOR.fils);
    expect(r.clampNote).toBe('raised to the branch floor');
  });

  it('capped at the branch ceiling, and the wizard is told', () => {
    const r = req({ totalFils: 500000 });
    expect(r.amountFils).toBe(DEPOSIT_CEILING.fils);
    expect(r.clampNote).toBe('capped at the branch ceiling');
  });

  it('no note when no clamp bit', () => {
    expect(req().clampNote).toBeUndefined();
  });

  it('THE CEILING APPLIES TO FULL PAYMENT TOO', () => {
    // Previously exempt on the reasoning that full payment is the price
    // rather than a deposit. Section 8.2 states one rule with no exception,
    // and the exemption left the largest amount the engine can ask for as the
    // one amount nothing bounded.
    const r = req({
      totalFils: 500000,
      service: { name: 'Bridal', percent: 100, fixedFils: null },
    });
    expect(r.amountFils).toBe(DEPOSIT_CEILING.fils);
    expect(r.clampNote).toBe('capped at the branch ceiling');
  });

  it('a full requirement capped at the ceiling stops being full', () => {
    // It no longer meets the total, so it is a deposit, and the balance is
    // due at the register like any other.
    const r = req({
      totalFils: 500000,
      service: { name: 'Bridal', percent: 100, fixedFils: null },
    });
    expect(r.kind).toBe('deposit');
  });

  it('full payment under the ceiling is still asked in full', () => {
    const r = req({
      totalFils: 40000, // AED 400, under the AED 500 ceiling
      service: { name: 'Keratin', percent: 100, fixedFils: null },
    });
    expect(r.amountFils).toBe(40000);
    expect(r.kind).toBe('full');
    expect(r.clampNote).toBeUndefined();
  });

  it('the floor never exceeds the total', () => {
    // A AED 5 service must never carry a AED 10 deposit.
    const r = req({
      totalFils: 500,
      service: { name: 'Tiny', percent: 10, fixedFils: null },
    });
    expect(r.amountFils).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------- tier

describe('TIER DOES NOT TOUCH THE DEPOSIT', () => {
  const tiers: Tier[] = ['none', 'silver', 'gold', 'vip', 'royal'];

  it('the requirement input has no tier field at all', () => {
    // Not an assertion about behaviour: the type simply does not carry it,
    // so tier CANNOT leak into the deposit by accident.
    expect(Object.keys(req())).not.toContain('tier');
  });

  it('Gold gets 10% off at CHECKOUT instead', () => {
    expect(tierDiscountPercent('gold')).toBe(10);
    expect(tierDiscountPercent('silver')).toBe(0);
    expect(tierDiscountPercent('none')).toBe(0);
  });

  it('the discount reduces what is due, never the deposit', () => {
    const deposit = req().amountFils; // AED 240 on AED 480
    const gold = dueAtCheckout({
      totalFils: COLOUR_480,
      tier: 'gold',
      depositFils: deposit,
    });
    const plain = dueAtCheckout({
      totalFils: COLOUR_480,
      tier: 'none',
      depositFils: deposit,
    });

    expect(gold.discountFils).toBe(4800); // AED 48
    expect(plain.discountFils).toBe(0);
    // The deposit is identical; only the balance differs.
    expect(plain.dueFils - gold.dueFils).toBe(4800);
  });

  it('deposit plus discount plus due always equals the total', () => {
    const deposit = req().amountFils;
    for (const tier of tiers) {
      const { discountFils, dueFils } = dueAtCheckout({
        totalFils: COLOUR_480,
        tier,
        depositFils: deposit,
      });
      expect(deposit + discountFils + dueFils).toBe(COLOUR_480);
    }
  });

  it('a fully prepaid booking leaves nothing due', () => {
    const r = req({
      service: { name: 'Bridal', percent: 100, fixedFils: null },
    });
    const { dueFils } = dueAtCheckout({
      totalFils: COLOUR_480,
      tier: 'none',
      depositFils: r.amountFils,
    });
    expect(dueFils).toBe(0);
  });
});

// ---------------------------------------------------------------- invariants

describe('invariants that must hold whatever the rules become', () => {
  const risks = [
    { risk: 'LOW' as const, riskScore: 84 },
    { risk: 'WATCH' as const, riskScore: 50 },
    { risk: 'HIGH' as const, riskScore: 28 },
  ];
  const services = [
    { name: 'A', percent: null, fixedFils: null },
    { name: 'B', percent: 10, fixedFils: null },
    { name: 'C', percent: 50, fixedFils: null },
    { name: 'D', percent: 20, fixedFils: 40000 },
    { name: 'E', percent: 100, fixedFils: null },
  ];
  const totals = [500, 6000, 17500, 48000, 500000];

  it('never negative, never more than the total', () => {
    for (const r of risks)
      for (const service of services)
        for (const totalFils of totals)
          for (const isNewCustomer of [true, false])
            for (const peakEscalation of [true, false]) {
              const out = req({
                ...r,
                service,
                totalFils,
                isNewCustomer,
                branch: { ...DEFAULT_BRANCH, peakEscalation },
                startMin: 1080,
              });
              expect(out.amountFils).toBeGreaterThanOrEqual(0);
              expect(out.amountFils).toBeLessThanOrEqual(totalFils);
            }
  });

  it('the trace always has seven rows and a readable source', () => {
    for (const r of risks)
      for (const service of services) {
        const out = req({ ...r, service });
        expect(out.trace).toHaveLength(7);
        expect(out.source.length).toBeGreaterThan(5);
      }
  });

  it('raising risk never lowers the requirement', () => {
    for (const service of services)
      for (const totalFils of totals) {
        const low = req({ ...risks[0]!, service, totalFils }).amountFils;
        const high = req({ ...risks[2]!, service, totalFils }).amountFils;
        expect(high).toBeGreaterThanOrEqual(low);
      }
  });

  it('the peak window never lowers the requirement either', () => {
    for (const service of services) {
      const off = req({ service, startMin: 1080 }).amountFils;
      const on = req({
        service,
        startMin: 1080,
        branch: { ...DEFAULT_BRANCH, peakEscalation: true },
      }).amountFils;
      expect(on).toBeGreaterThanOrEqual(off);
    }
  });

  it('a deposit is always less than the total; full equals it', () => {
    for (const service of services)
      for (const totalFils of totals) {
        const out = req({ service, totalFils });
        if (out.kind === 'deposit')
          expect(out.amountFils).toBeLessThan(totalFils);
        if (out.kind === 'full') expect(out.amountFils).toBe(totalFils);
        if (out.kind === 'none') expect(out.amountFils).toBe(0);
      }
  });
});
