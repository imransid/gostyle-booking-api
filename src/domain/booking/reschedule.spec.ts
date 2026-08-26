import { describe, it, expect } from 'vitest';
import {
  rescheduleOutcome,
  SERIAL_MOVE_THRESHOLD,
  SERIAL_MOVE_PERCENT,
  type RescheduleInput,
} from './reschedule';
import { Money } from '../shared/money';

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const aed = (f: number): string => Money.fils(f).toString();

function move(over: Partial<RescheduleInput> = {}) {
  return rescheduleOutcome({
    nowMs: NOW,
    currentStartAtMs: NOW + 48 * H,
    capturedFils: 24000,
    totalFils: 48000,
    moveCount: 0,
    ...over,
  });
}

describe('WITHIN POLICY the money carries untouched', () => {
  it('a deposit stays where it is', () => {
    const r = move();
    expect(r.money.kind).toBe('carries');
    expect(r.money.kind === 'carries' && aed(r.money.amountFils)).toBe(
      'AED 240.00',
    );
    expect(r.lateMove).toBe(false);
  });

  it('and the explanation says so', () => {
    expect(move().explanation).toContain('carries to the new time untouched');
  });

  it('nothing captured means nothing to carry', () => {
    const r = move({ capturedFils: 0 });
    expect(r.money.kind === 'carries' && r.money.amountFils).toBe(0);
    expect(r.explanation).toContain('nothing changes');
  });

  it('the move counter always goes up', () => {
    expect(move({ moveCount: 0 }).newMoveCount).toBe(1);
    expect(move({ moveCount: 7 }).newMoveCount).toBe(8);
  });

  it('exactly at the 2-hour boundary is still within policy', () => {
    expect(move({ currentStartAtMs: NOW + 2 * H }).lateMove).toBe(false);
  });
});

describe('INSIDE THE LATE WINDOW it is a late cancel plus a new booking', () => {
  it('the deposit is forfeited, not carried', () => {
    const r = move({ currentStartAtMs: NOW + 1 * H });
    expect(r.money.kind).toBe('forfeit_and_requote');
    expect(
      r.money.kind === 'forfeit_and_requote' && aed(r.money.forfeitedFils),
    ).toBe('AED 240.00');
    expect(r.lateMove).toBe(true);
  });

  it('and the new time is quoted fresh', () => {
    expect(move({ currentStartAtMs: NOW + 1 * H }).explanation).toContain(
      'quoted fresh',
    );
  });

  it('a minute inside the window is late', () => {
    expect(move({ currentStartAtMs: NOW + 2 * H - 60_000 }).lateMove).toBe(
      true,
    );
  });

  it('policy is judged on the OLD time, not the new one', () => {
    // Moving a booking that starts in an hour is late, wherever it lands.
    expect(move({ currentStartAtMs: NOW + 1 * H }).lateMove).toBe(true);
  });

  it('with nothing captured there is nothing to forfeit', () => {
    const r = move({ currentStartAtMs: NOW + 1 * H, capturedFils: 0 });
    expect(
      r.money.kind === 'forfeit_and_requote' && r.money.forfeitedFils,
    ).toBe(0);
    expect(r.explanation).toContain('Nothing was captured');
  });

  it('a late move never also triggers the serial rule', () => {
    // It is already being re-quoted, so a second requirement would double up.
    const r = move({
      currentStartAtMs: NOW + 1 * H,
      capturedFils: 0,
      moveCount: 9,
    });
    expect(r.acquiresDepositFils).toBeNull();
  });
});

describe('THE SERIAL RESCHEDULER RULE', () => {
  it('the first three moves are free', () => {
    for (const moveCount of [0, 1, 2]) {
      expect(
        move({ capturedFils: 0, moveCount }).acquiresDepositFils,
      ).toBeNull();
    }
  });

  it('the fourth acquires a 20% deposit', () => {
    const r = move({ capturedFils: 0, moveCount: SERIAL_MOVE_THRESHOLD - 1 });
    expect(aed(r.acquiresDepositFils!)).toBe('AED 96.00');
    expect(r.newMoveCount).toBe(SERIAL_MOVE_THRESHOLD);
  });

  it('and so does the fifth, and the tenth', () => {
    expect(
      move({ capturedFils: 0, moveCount: 4 }).acquiresDepositFils,
    ).not.toBeNull();
    expect(
      move({ capturedFils: 0, moveCount: 9 }).acquiresDepositFils,
    ).not.toBeNull();
  });

  it('IT ONLY REACHES A BOOKING WITH NOTHING AT STAKE', () => {
    // A booking that already carries a deposit is not holding the slot
    // hostage: it has skin in the game already.
    const r = move({ capturedFils: 24000, moveCount: 9 });
    expect(r.acquiresDepositFils).toBeNull();
    expect(r.money.kind === 'carries' && r.money.amountFils).toBe(24000);
  });

  it('the percentage is of the total, rounded to whole dirhams', () => {
    const r = move({ capturedFils: 0, moveCount: 3, totalFils: 17500 });
    // 20% of AED 175 is AED 35 exactly.
    expect(aed(r.acquiresDepositFils!)).toBe('AED 35.00');
  });

  it('the explanation names the move number and the link', () => {
    const r = move({ capturedFils: 0, moveCount: 3 });
    expect(r.explanation).toContain('Move 4');
    expect(r.explanation).toContain(`${SERIAL_MOVE_PERCENT}%`);
    expect(r.explanation).toContain('payment link');
  });

  it('IT ATTACHES TO THE BOOKING, NOT THE PERSON', () => {
    // Two bookings, same customer. Only the one that has been moved four
    // times acquires anything, so one difficult week does not follow them.
    expect(
      move({ capturedFils: 0, moveCount: 3 }).acquiresDepositFils,
    ).not.toBeNull();
    expect(
      move({ capturedFils: 0, moveCount: 0 }).acquiresDepositFils,
    ).toBeNull();
  });
});

describe('invariants', () => {
  const starts = [NOW + 1 * H, NOW + 2 * H, NOW + 25 * H, NOW - H];
  const captures = [0, 1000, 24000, 48000];
  const counts = [0, 3, 4, 12];

  it('the counter always advances by exactly one', () => {
    for (const currentStartAtMs of starts)
      for (const capturedFils of captures)
        for (const moveCount of counts) {
          const r = move({ currentStartAtMs, capturedFils, moveCount });
          expect(r.newMoveCount).toBe(moveCount + 1);
        }
  });

  it('money is never invented: carried or forfeited equals captured', () => {
    for (const currentStartAtMs of starts)
      for (const capturedFils of captures) {
        const r = move({ currentStartAtMs, capturedFils });
        const accounted =
          r.money.kind === 'carries'
            ? r.money.amountFils
            : r.money.forfeitedFils;
        // The one exception is the serial rule, which takes NEW money rather
        // than moving old money, and only ever when there was none.
        if (r.acquiresDepositFils === null) {
          expect(accounted).toBe(capturedFils);
        } else {
          expect(capturedFils).toBe(0);
        }
      }
  });

  it('an acquired deposit never exceeds the total', () => {
    for (const totalFils of [500, 6000, 48000, 500000]) {
      const r = move({ capturedFils: 0, moveCount: 3, totalFils });
      expect(r.acquiresDepositFils!).toBeLessThanOrEqual(totalFils);
    }
  });

  it('every outcome explains itself', () => {
    for (const currentStartAtMs of starts)
      for (const capturedFils of captures)
        for (const moveCount of counts) {
          expect(
            move({ currentStartAtMs, capturedFils, moveCount }).explanation
              .length,
          ).toBeGreaterThan(20);
        }
  });
});
