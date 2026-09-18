import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_STATES,
  isListable,
  parseFilter,
  shelfOf,
} from './booking-shelf';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const HOUR = 3_600_000;
const shelf = (
  status: Parameters<typeof shelfOf>[0]['status'],
  endsAtMs: number,
) => shelfOf({ status, endsAtMs, nowMs: NOW });

describe('shelfOf', () => {
  it('puts a live booking in the future on upcoming', () => {
    expect(shelf('confirmed', NOW + HOUR)).toBe('upcoming');
    expect(shelf('pending_payment', NOW + HOUR)).toBe('upcoming');
    expect(shelf('pending_confirmation', NOW + HOUR)).toBe('upcoming');
    expect(shelf('checked_in', NOW + HOUR)).toBe('upcoming');
  });

  it('archives a booking whose time has passed, even if nobody closed it', () => {
    // Nothing sweeps a confirmed booking the customer simply did not
    // attend, so status alone would leave last March on the upcoming tab
    // forever.
    expect(shelf('confirmed', NOW - HOUR)).toBe('archive');
  });

  it('archives a cancelled booking even though its date is ahead', () => {
    // THE ONE THAT MATTERS. Time alone would show this under a heading
    // meaning "what is coming", and someone turns up for an appointment
    // that is not there.
    expect(shelf('cancelled', NOW + 30 * 24 * HOUR)).toBe('archive');
    expect(shelf('expired', NOW + HOUR)).toBe('archive');
    expect(shelf('no_show', NOW + HOUR)).toBe('archive');
    expect(shelf('rescheduled', NOW + HOUR)).toBe('archive');
  });

  it('keeps a visit in progress on upcoming until it ends', () => {
    // Started an hour ago, ends in an hour. The customer is in the chair;
    // measuring from the start would move it to history mid-haircut.
    expect(shelf('in_service', NOW + HOUR)).toBe('upcoming');
    expect(shelf('in_service', NOW - 1)).toBe('archive');
  });

  it('archives completed, which is not terminal but has happened', () => {
    // completed still moves on to settled, so TERMINAL_STATES does not
    // hold it. "Cannot move" and "is history" are different questions.
    expect(shelf('completed', NOW + HOUR)).toBe('archive');
    expect(shelf('settled', NOW + HOUR)).toBe('archive');
  });

  it('treats the end instant itself as past', () => {
    expect(shelf('confirmed', NOW)).toBe('archive');
    expect(shelf('confirmed', NOW + 1)).toBe('upcoming');
  });
});

describe('ARCHIVE_STATES', () => {
  it('agrees with shelfOf on every status, for a booking still ahead', () => {
    // THE POINT OF EXPORTING IT. The list query filters in SQL from this
    // set while a single booking is classified by shelfOf; if the two ever
    // part company, a booking is on one shelf in the list and another in
    // the drawer. This pins them together for all fourteen statuses.
    const ALL: Parameters<typeof shelfOf>[0]['status'][] = [
      'draft',
      'held',
      'pending_payment',
      'pending_confirmation',
      'confirmed',
      'checked_in',
      'in_service',
      'completed',
      'settled',
      'cancelled',
      'no_show',
      'rescheduled',
      'expired',
      'skipped',
    ];
    for (const status of ALL) {
      const byQuery = ARCHIVE_STATES.has(status) ? 'archive' : 'upcoming';
      expect([status, shelf(status, NOW + HOUR)]).toEqual([status, byQuery]);
    }
  });
});

describe('parseFilter', () => {
  it('defaults to upcoming when nothing is asked for', () => {
    expect(parseFilter(undefined)).toBe('upcoming');
    expect(parseFilter(null)).toBe('upcoming');
    expect(parseFilter('')).toBe('upcoming');
  });

  it('accepts the three tabs, recurring included', () => {
    // recurring answers an empty page rather than 422. "You have no
    // routines" and "there is no such tab" are different sentences.
    expect(parseFilter('upcoming')).toBe('upcoming');
    expect(parseFilter('recurring')).toBe('recurring');
    expect(parseFilter('archive')).toBe('archive');
  });

  it('refuses anything else rather than falling back to the default', () => {
    // A typo silently answered with `upcoming` is how a client ships a tab
    // that has never once shown what it claims to.
    expect(parseFilter('past')).toBeNull();
    expect(parseFilter('UPCOMING')).toBeNull();
    expect(parseFilter('all')).toBeNull();
  });
});

describe('isListable', () => {
  const listable = (
    status: Parameters<typeof shelfOf>[0]['status'],
    paymentStatus: Parameters<typeof isListable>[0]['paymentStatus'],
  ) => isListable({ status, paymentStatus });

  it('hides a DRAFT checkout from all three shelves', () => {
    // §2.3 both halves: inside its window it is not a booking yet, and
    // expired it is gone rather than archived. `unpaid` is the app's DRAFT.
    expect(listable('pending_payment', 'unpaid')).toBe(false);
    expect(listable('expired', 'unpaid')).toBe(false);
  });

  it('shows a PAY_AFTER_CHECK_IN booking, which is settled by arrangement', () => {
    // none_required is not unfinished: the salon is holding a chair for it.
    expect(listable('confirmed', 'none_required')).toBe(true);
  });

  it('shows anything money has moved against', () => {
    expect(listable('confirmed', 'deposit_paid')).toBe(true);
    expect(listable('confirmed', 'fully_paid')).toBe(true);
    expect(listable('cancelled', 'refunded')).toBe(true);
  });

  it('never lists a shell row or a bare hold', () => {
    expect(listable('draft', 'fully_paid')).toBe(false);
    expect(listable('held', 'fully_paid')).toBe(false);
  });
});

describe('the three badges', () => {
  it('names a shelf for every filter the parser accepts', () => {
    // WHAT THE LIVE BUG WAS. The repository counts two shelves, the
    // contract draws three badges, and the response was built from the
    // repository's object directly -- so `counts.recurring` came back
    // undefined and the app rendered an empty chip instead of a zero.
    // Every word parseFilter accepts must have a badge.
    const badges = new Set(['upcoming', 'recurring', 'archive']);
    for (const word of ['upcoming', 'recurring', 'archive']) {
      expect([word, badges.has(parseFilter(word) ?? '')]).toEqual([word, true]);
    }
  });
});
