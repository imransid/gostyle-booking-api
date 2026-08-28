import { describe, it, expect } from 'vitest';
import {
  planParty,
  type PartyParticipant,
  type PartyContext,
  type GroupMode,
} from './party';

function pro(
  id: string,
  skills: string[],
  over: Partial<PartyContext['professionals'][0]> = {},
) {
  return { id, name: id, skills, atCap: false, busy: [], ...over };
}

function guest(
  id: string,
  over: Partial<PartyParticipant> = {},
): PartyParticipant {
  return {
    id,
    label: id,
    skills: ['hair'],
    durationMin: 60,
    resourceType: 'styling',
    preferredStaffId: null,
    ...over,
  };
}

function ctx(over: Partial<PartyContext> = {}): PartyContext {
  return {
    professionals: [
      pro('maya', ['hair', 'color']),
      pro('anya', ['hair', 'color']),
      pro('reem', ['hair']),
      pro('lina', ['nails']),
    ],
    resourceCounts: { styling: 4, color: 2, nails: 3 },
    occupied: [],
    ...over,
  };
}

const plan = (
  ps: PartyParticipant[],
  mode: GroupMode = 'arrive_together',
  c = ctx(),
) => planParty(ps, 600, mode, c);

describe('the shape of a group', () => {
  it('two is the minimum', () => {
    const out = plan([guest('a')]);
    expect(out.kind).toBe('infeasible');
    expect(out.kind === 'infeasible' && out.reason).toContain('at least two');
  });

  it('a plain pair is planned', () => {
    const out = plan([guest('a'), guest('b')]);
    expect(out.kind).toBe('planned');
    expect(out.kind === 'planned' && out.lanes).toHaveLength(2);
  });

  it('NO PROFESSIONAL IS EVER COUNTED TWICE', () => {
    const out = plan([guest('a'), guest('b'), guest('c')]);
    expect(out.kind).toBe('planned');
    if (out.kind !== 'planned') return;
    const staff = out.lanes.map((l) => l.staffId);
    expect(new Set(staff).size).toBe(staff.length);
  });

  it('lanes come back in the order the caller asked, not the search order', () => {
    const out = plan([guest('a'), guest('b'), guest('c')]);
    expect(
      out.kind === 'planned' && out.lanes.map((l) => l.participantId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('mixed services are the normal case', () => {
    const out = plan([
      guest('a', { skills: ['color'], resourceType: 'color' }),
      guest('b', { skills: ['nails'], resourceType: 'nails' }),
    ]);
    expect(out.kind).toBe('planned');
  });
});

describe('ARRIVE TOGETHER: everyone starts at once', () => {
  it('all lanes share a start', () => {
    const out = plan([
      guest('a', { durationMin: 45 }),
      guest('b', { durationMin: 120 }),
    ]);
    expect(
      out.kind === 'planned' && out.lanes.every((l) => l.startMin === 600),
    ).toBe(true);
  });

  it('and they finish apart', () => {
    const out = plan([
      guest('a', { durationMin: 45 }),
      guest('b', { durationMin: 120 }),
    ]);
    expect(out.kind === 'planned' && out.lanes.map((l) => l.endMin)).toEqual([
      645, 720,
    ]);
  });
});

describe('FINISH TOGETHER: starts stagger backwards', () => {
  it('everyone ends at the same minute', () => {
    const out = plan(
      [guest('a', { durationMin: 45 }), guest('b', { durationMin: 120 })],
      'finish_together',
    );
    expect(out.kind).toBe('planned');
    if (out.kind !== 'planned') return;
    expect(new Set(out.lanes.map((l) => l.endMin)).size).toBe(1);
  });

  it('the shorter service starts later', () => {
    const out = plan(
      [guest('a', { durationMin: 45 }), guest('b', { durationMin: 120 })],
      'finish_together',
    );
    if (out.kind !== 'planned') return;
    const [a, b] = out.lanes;
    expect(a!.startMin).toBeGreaterThan(b!.startMin);
    // The longest service anchors the start.
    expect(b!.startMin).toBe(600);
    expect(a!.startMin).toBe(675);
  });

  it('THE POINT: the party leaves as one', () => {
    const out = plan(
      [
        guest('a', { durationMin: 30 }),
        guest('b', { durationMin: 90 }),
        guest('c', { durationMin: 60 }),
      ],
      'finish_together',
    );
    if (out.kind !== 'planned') return;
    expect(new Set(out.lanes.map((l) => l.endMin)).size).toBe(1);
  });
});

describe('refusals explain themselves, with a remedy', () => {
  it('nobody covers a participant', () => {
    const out = plan([guest('a', { skills: ['massage'] }), guest('b')]);
    expect(out.kind === 'infeasible' && out.reason).toContain("a's services");
    expect(out.kind === 'infeasible' && out.remedy).toContain('another time');
  });

  it('a named professional who cannot be had', () => {
    const out = plan([guest('a', { preferredStaffId: 'nobody' }), guest('b')]);
    expect(out.kind === 'infeasible' && out.remedy).toContain(
      'Relax the professional preference',
    );
  });

  it('EVERYONE NEEDS THEIR OWN, so the union matters', () => {
    // Three participants, but only two people hold the skill.
    const out = plan([
      guest('a', { skills: ['color'] }),
      guest('b', { skills: ['color'] }),
      guest('c', { skills: ['color'] }),
    ]);
    expect(out.kind).toBe('infeasible');
    expect(out.kind === 'infeasible' && out.reason).toContain(
      'Only 2 professionals',
    );
    expect(out.kind === 'infeasible' && out.reason).toContain('each of the 3');
  });

  it('more stations than the branch owns', () => {
    const out = planParty(
      [
        guest('a', { skills: ['nails'], resourceType: 'nails' }),
        guest('b', { skills: ['nails'], resourceType: 'nails' }),
      ],
      600,
      'arrive_together',
      ctx({
        professionals: [pro('lina', ['nails']), pro('reem', ['nails'])],
        resourceCounts: { nails: 1 },
      }),
    );
    expect(out.kind).toBe('infeasible');
    expect(out.kind === 'infeasible' && out.reason).toContain('nails stations');
    expect(out.kind === 'infeasible' && out.reason).toContain('branch has 1');
  });
});

describe("CHAIRS ARE COUNTED PER SLICE, INCLUDING THIS PLAN'S OWN LANES", () => {
  it('a party of four is not sold three stations', () => {
    const out = planParty(
      [guest('a'), guest('b'), guest('c'), guest('d')],
      600,
      'arrive_together',
      ctx({
        professionals: [
          pro('m', ['hair']),
          pro('a', ['hair']),
          pro('r', ['hair']),
          pro('s', ['hair']),
        ],
        resourceCounts: { styling: 3 },
      }),
    );
    expect(out.kind).toBe('infeasible');
  });

  it('but four fit when there are four stations', () => {
    const out = planParty(
      [guest('a'), guest('b'), guest('c'), guest('d')],
      600,
      'arrive_together',
      ctx({
        professionals: [
          pro('m', ['hair']),
          pro('a', ['hair']),
          pro('r', ['hair']),
          pro('s', ['hair']),
        ],
        resourceCounts: { styling: 4 },
      }),
    );
    expect(out.kind).toBe('planned');
  });

  it('the existing diary counts too', () => {
    const out = planParty(
      [guest('a'), guest('b')],
      600,
      'arrive_together',
      ctx({
        resourceCounts: { styling: 2 },
        occupied: [{ resourceType: 'styling', fromMin: 580, toMin: 700 }],
      }),
    );
    expect(out.kind).toBe('infeasible');
  });

  it('and a chair that frees before the party starts does not', () => {
    const out = planParty(
      [guest('a'), guest('b')],
      600,
      'arrive_together',
      ctx({
        resourceCounts: { styling: 2 },
        occupied: [{ resourceType: 'styling', fromMin: 500, toMin: 600 }],
      }),
    );
    expect(out.kind).toBe('planned');
  });

  it('BOTH MODES PEAK AT THE SAME NUMBER OF CHAIRS', () => {
    // Worth stating, because it is tempting to assume staggering the starts
    // eases chair pressure. It does not: arrive-together has everyone
    // overlapping at the START, finish-together has everyone overlapping at
    // the END, and both peak at one chair per participant.
    const c = ctx({
      professionals: [pro('m', ['hair']), pro('a', ['hair'])],
      resourceCounts: { styling: 1 },
    });
    const people = [
      guest('a', { durationMin: 60 }),
      guest('b', { durationMin: 120 }),
    ];
    expect(planParty(people, 600, 'arrive_together', c).kind).toBe(
      'infeasible',
    );
    expect(planParty(people, 600, 'finish_together', c).kind).toBe(
      'infeasible',
    );
  });

  it('what finish-together DOES buy is staff who are busy earlier', () => {
    // Maya is booked until 11:00. Arriving together at 10:00 she is out;
    // staggered so the short service starts at 11:15, she is available.
    const c = ctx({
      professionals: [
        pro('maya', ['hair'], { busy: [{ fromMin: 540, toMin: 660 }] }),
        pro('anya', ['hair']),
      ],
      resourceCounts: { styling: 4 },
    });
    const people = [
      guest('short', { durationMin: 45 }),
      guest('long', { durationMin: 120 }),
    ];
    expect(planParty(people, 600, 'arrive_together', c).kind).toBe(
      'infeasible',
    );
    expect(planParty(people, 600, 'finish_together', c).kind).toBe('planned');
  });
});

describe('the diary and the daily cap', () => {
  it('a busy professional is not offered', () => {
    const out = planParty(
      [guest('a'), guest('b')],
      600,
      'arrive_together',
      ctx({
        professionals: [
          pro('m', ['hair'], { busy: [{ fromMin: 590, toMin: 700 }] }),
          pro('a', ['hair']),
          pro('r', ['hair']),
        ],
      }),
    );
    if (out.kind !== 'planned') throw new Error('expected a plan');
    expect(out.lanes.map((l) => l.staffId)).not.toContain('m');
  });

  it('anyone at their daily cap is dropped first', () => {
    const out = planParty(
      [guest('a'), guest('b')],
      600,
      'arrive_together',
      ctx({
        professionals: [
          pro('m', ['hair'], { atCap: true }),
          pro('a', ['hair'], { atCap: true }),
          pro('r', ['hair']),
        ],
      }),
    );
    expect(out.kind).toBe('infeasible');
  });
});

describe('SCARCITY ORDER is what makes the search terminate', () => {
  it('the constrained participant is matched first', () => {
    // 'rare' can only have lina. If the search placed the flexible ones
    // first it could take lina and then fail.
    const out = planParty(
      [
        guest('flex1', { skills: ['hair'] }),
        guest('flex2', { skills: ['hair'] }),
        guest('rare', { skills: ['nails'], resourceType: 'nails' }),
      ],
      600,
      'arrive_together',
      ctx({
        professionals: [
          pro('lina', ['nails', 'hair']),
          pro('maya', ['hair']),
          pro('anya', ['hair']),
        ],
      }),
    );
    expect(out.kind).toBe('planned');
    if (out.kind !== 'planned') return;
    expect(out.lanes.find((l) => l.participantId === 'rare')!.staffId).toBe(
      'lina',
    );
  });

  it('BACKTRACKING: a first choice that dooms the rest is undone', () => {
    // maya is the only one who can do colour, and also the obvious pick for
    // hair. A greedy search that gave maya to the hair participant would
    // fail; this must not.
    const out = planParty(
      [
        guest('hair', { skills: ['hair'] }),
        guest('colour', { skills: ['color'], resourceType: 'color' }),
      ],
      600,
      'arrive_together',
      ctx({
        professionals: [pro('maya', ['hair', 'color']), pro('reem', ['hair'])],
      }),
    );
    expect(out.kind).toBe('planned');
    if (out.kind !== 'planned') return;
    expect(out.lanes.find((l) => l.participantId === 'colour')!.staffId).toBe(
      'maya',
    );
    expect(out.lanes.find((l) => l.participantId === 'hair')!.staffId).toBe(
      'reem',
    );
  });
});

describe('invariants', () => {
  const people = [guest('a'), guest('b'), guest('c')];

  it('a plan always has one lane per participant', () => {
    const out = plan(people);
    expect(out.kind === 'planned' && out.lanes).toHaveLength(3);
  });

  it('every lane respects its participant duration', () => {
    const out = plan([
      guest('a', { durationMin: 45 }),
      guest('b', { durationMin: 90 }),
    ]);
    if (out.kind !== 'planned') return;
    expect(out.lanes[0]!.endMin - out.lanes[0]!.startMin).toBe(45);
    expect(out.lanes[1]!.endMin - out.lanes[1]!.startMin).toBe(90);
  });

  it('every refusal carries a remedy', () => {
    const cases = [
      [guest('a')],
      [guest('a', { skills: ['massage'] }), guest('b')],
      [
        guest('a', { skills: ['color'] }),
        guest('b', { skills: ['color'] }),
        guest('c', { skills: ['color'] }),
      ],
    ];
    for (const c of cases) {
      const out = plan(c);
      if (out.kind !== 'infeasible') continue;
      expect(out.remedy.length).toBeGreaterThan(10);
    }
  });

  it('a plan is never returned with a double-booked professional', () => {
    for (const size of [2, 3, 4]) {
      const party = Array.from({ length: size }, (_, i) => guest(`p${i}`));
      const out = planParty(
        party,
        600,
        'arrive_together',
        ctx({
          professionals: [
            pro('a', ['hair']),
            pro('b', ['hair']),
            pro('c', ['hair']),
            pro('d', ['hair']),
          ],
          resourceCounts: { styling: 4 },
        }),
      );
      if (out.kind !== 'planned') continue;
      const ids = out.lanes.map((l) => l.staffId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
