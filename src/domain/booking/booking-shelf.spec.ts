import { describe, it, expect } from 'vitest';
import { shelfOf } from './booking-shelf';

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
