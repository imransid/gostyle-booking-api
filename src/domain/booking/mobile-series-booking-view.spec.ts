import { describe, expect, it } from 'vitest';
import {
  addsNothing,
  priceToday,
  sumVisits,
  type VisitFigures,
} from './mobile-series-booking-view';
import { paidAndDue } from './mobile-contract';

/** A visit worth AED 105 (100 net + 5 VAT), with `captured` taken. */
const visit = (
  captured = 0,
  over: Partial<VisitFigures> = {},
): VisitFigures => ({
  subtotalFils: 10_000,
  vatFils: 500,
  discountFils: 0,
  totalFils: 10_500,
  capturedFils: captured,
  dueFils: Math.max(0, 10_500 - captured),
  ...over,
});

describe('addsNothing (B7): which sessions add nothing to their routine', () => {
  it.each([
    ['CANCELLED', true],
    ['BOOKED', false],
    ['CONFIRMED_BY_SALON', false],
    ['CHECKED_IN', false],
    ['COMPLETED', false],
  ] as const)('a booking the single read calls %s: %s', (status, nothing) => {
    expect(addsNothing({ skipped: false, bookingStatus: status })).toBe(
      nothing,
    );
  });

  it('skipped through the routine adds nothing, whatever its booking says', () => {
    expect(addsNothing({ skipped: true, bookingStatus: 'COMPLETED' })).toBe(
      true,
    );
    expect(addsNothing({ skipped: true, bookingStatus: null })).toBe(true);
  });

  it('a session with no booking that is not skipped adds something', () => {
    expect(addsNothing({ skipped: false, bookingStatus: null })).toBe(false);
  });
});

describe('priceToday (B7): a session not booked yet', () => {
  it('nothing taken, all of it due', () => {
    expect(
      priceToday({
        subtotalFils: 10_000,
        vatFils: 500,
        discountFils: 0,
        totalFils: 10_500,
      }),
    ).toStrictEqual({
      subtotalFils: 10_000,
      vatFils: 500,
      discountFils: 0,
      totalFils: 10_500,
      capturedFils: 0,
      dueFils: 10_500,
    });
  });
});

describe('sumVisits (B7): the routine is the sum of its visits', () => {
  it('adds each figure; a session that adds nothing (null) is left out', () => {
    // Paid at the desk (net 100 of 105), skipped, booked, planned.
    expect(sumVisits([visit(10_000), null, visit(), visit()])).toStrictEqual({
      subtotalFils: 30_000,
      vatFils: 1_500,
      discountFils: 0,
      totalFils: 31_500,
      capturedFils: 10_000,
      dueFils: 21_500,
    });
  });

  it("a figure one visit cannot give makes the routine's unknown, never smaller", () => {
    const unpriced = visit(0, {
      subtotalFils: null,
      totalFils: null,
      dueFils: null,
    });
    const sum = sumVisits([visit(), unpriced]);
    expect(sum.totalFils).toBeNull();
    expect(sum.subtotalFils).toBeNull();
    expect(sum.dueFils).toBeNull();
    expect(sum.capturedFils).toBe(0);
  });

  it('nothing at all adds up to zero', () => {
    expect(sumVisits([null, null])).toStrictEqual({
      subtotalFils: 0,
      vatFils: 0,
      discountFils: 0,
      totalFils: 0,
      capturedFils: 0,
      dueFils: 0,
    });
  });
});

describe('paidAndDue (B7): the single read and the routine share it', () => {
  const row = (
    entryType: string,
    amountFils: number,
    rail: string | null = 'cash',
  ) => ({
    entryType,
    amountFils,
    rail,
  });

  it('only captures count as taken; refunds and forfeits do not', () => {
    expect(
      paidAndDue(16_800, [
        row('captured', 10_000),
        row('refunded', -10_000),
        row('forfeited', -2_000),
      ]),
    ).toStrictEqual({ capturedFils: 10_000, dueFils: 6_800, lastRail: 'cash' });
  });

  it('due is never below 0, and unknown when the total is', () => {
    expect(paidAndDue(10_000, [row('captured', 12_000)]).dueFils).toBe(0);
    expect(paidAndDue(null, [row('captured', 12_000)]).dueFils).toBeNull();
  });

  it("the rail is the last capture's", () => {
    expect(
      paidAndDue(20_000, [
        row('captured', 5_000, 'card'),
        row('captured', 5_000, 'cash'),
      ]).lastRail,
    ).toBe('cash');
    expect(paidAndDue(20_000, []).lastRail).toBeNull();
  });
});
