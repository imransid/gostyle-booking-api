import { describe, it, expect } from 'vitest';
import {
  nearestOptions,
  queue,
  NOW_WINDOW_MIN,
  OPTIONS_SHOWN,
  type WalkIn,
  type WalkInCandidate,
} from './walk-in';

const NOW = 840; // 14:00

const c = (
  startMin: number,
  staffId: string,
  staffName = staffId,
): WalkInCandidate => ({
  startMin,
  staffId,
  staffName,
});

const w = (
  id: string,
  joinedMin: number,
  over: Partial<WalkIn> = {},
): WalkIn => ({
  id,
  label: id,
  serviceIds: ['blow-dry'],
  durationMin: 45,
  joinedMin,
  ...over,
});

describe('the nearest options', () => {
  it('says a professional is free NOW when the start is immediate', () => {
    const [first] = nearestOptions([c(NOW, 'maya', 'Maya')], NOW);
    expect(first?.kind).toBe('now');
    expect(first?.label).toBe('Maya is free now');
  });

  it('still says now inside the quarter-hour window', () => {
    const [first] = nearestOptions(
      [c(NOW + NOW_WINDOW_MIN, 'maya', 'Maya')],
      NOW,
    );
    expect(first?.kind).toBe('now');
  });

  it('says "free from" once the wait is real', () => {
    // Twenty minutes is a wait, and calling it "now" is the sort of small
    // lie the desk gets blamed for.
    const [first] = nearestOptions([c(NOW + 20, 'lina', 'Lina')], NOW);
    expect(first?.kind).toBe('from');
    expect(first?.label).toBe('Lina free from 14:20');
  });

  it('formats the time the way the queue shows it', () => {
    // 14:15 is exactly the now-window boundary, so this uses a start past it.
    const [first] = nearestOptions([c(870, 'lina', 'Lina')], NOW);
    expect(first?.label).toBe('Lina free from 14:30');
  });

  it('never offers a start that has already passed', () => {
    const options = nearestOptions([c(NOW - 30, 'maya', 'Maya')], NOW);
    expect(options).toEqual([]);
  });

  it('gives one option per professional, not three from one', () => {
    const options = nearestOptions(
      [
        c(NOW, 'maya', 'Maya'),
        c(NOW + 5, 'maya', 'Maya'),
        c(NOW + 10, 'maya', 'Maya'),
      ],
      NOW,
    );
    expect(options.filter((o) => o.kind !== 'next_gap').length).toBe(1);
  });

  it('shows at most three', () => {
    const options = nearestOptions(
      [
        c(NOW, 'a', 'A'),
        c(NOW + 20, 'b', 'B'),
        c(NOW + 40, 'c', 'C'),
        c(NOW + 60, 'd', 'D'),
      ],
      NOW,
    );
    expect(options.length).toBeLessThanOrEqual(OPTIONS_SHOWN);
  });

  it('orders by how soon, then deterministically', () => {
    const a = nearestOptions([c(NOW + 20, 'z', 'Z'), c(NOW, 'y', 'Y')], NOW);
    const b = nearestOptions([c(NOW, 'y', 'Y'), c(NOW + 20, 'z', 'Z')], NOW);
    expect(a.map((o) => o.label)).toEqual(b.map((o) => o.label));
    expect(a[0]?.label).toBe('Y is free now');
  });

  it('adds a bare next gap when there is room for one', () => {
    const options = nearestOptions(
      [c(NOW, 'maya', 'Maya'), c(NOW + 90, 'maya', 'Maya')],
      NOW,
    );
    expect(options.some((o) => o.kind === 'next_gap')).toBe(true);
    expect(options.find((o) => o.kind === 'next_gap')?.label).toBe(
      'Next gap 15:30',
    );
  });

  it('returns nothing when the day is full', () => {
    expect(nearestOptions([], NOW)).toEqual([]);
  });
});

describe('the queue', () => {
  const candidates = (): WalkInCandidate[] => [c(NOW, 'maya', 'Maya')];

  it('is ordered by arrival, not by service value', () => {
    const rows = queue([w('second', 830), w('first', 800)], NOW, candidates);
    expect(rows.map((r) => r.walkIn.id)).toEqual(['first', 'second']);
    expect(rows[0]?.position).toBe(1);
  });

  it('shows how long each person has been waiting', () => {
    const rows = queue([w('a', 800)], NOW, candidates);
    expect(rows[0]?.waitingMin).toBe(40);
  });

  it('never shows a negative wait', () => {
    const rows = queue([w('a', NOW + 30)], NOW, candidates);
    expect(rows[0]?.waitingMin).toBe(0);
  });

  it('quotes each person against their OWN services', () => {
    // The colourist being free is no use to somebody waiting for a manicure.
    const rows = queue(
      [w('hair', 800), w('nails', 810, { serviceIds: ['gel-manicure'] })],
      NOW,
      (walkIn) =>
        walkIn.serviceIds.includes('gel-manicure')
          ? []
          : [c(NOW, 'maya', 'Maya')],
    );
    expect(rows[0]?.options.length).toBeGreaterThan(0);
    expect(rows[1]?.options).toEqual([]);
  });

  it('tells the desk what to do when nothing fits', () => {
    const rows = queue([w('a', 800)], NOW, () => []);
    expect(rows[0]?.explanation).toMatch(/Offer the waitlist/);
  });

  it('reads as one line per person', () => {
    const rows = queue([w('Dana', 800)], NOW, candidates);
    expect(rows[0]?.explanation).toMatch(
      /Dana, waiting 40 min: Maya is free now/,
    );
  });

  it('breaks an arrival tie deterministically', () => {
    const a = queue([w('b', 800), w('a', 800)], NOW, candidates);
    const b = queue([w('a', 800), w('b', 800)], NOW, candidates);
    expect(a.map((r) => r.walkIn.id)).toEqual(b.map((r) => r.walkIn.id));
  });
});
