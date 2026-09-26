import { describe, it, expect } from 'vitest';
import {
  ROUTINE_ROW_FIELDS,
  routineRow,
  sortRoutines,
} from './mobile-series-list';

const routine = (
  id: string,
  status: string,
  next: string | null,
  created: string,
) => ({
  id,
  status,
  created_at: created,
  next_session: next === null ? null : { start_time: next },
});

describe('sortRoutines: the Recurring tab order', () => {
  it('puts live routines (ACTIVE, PAUSED) before ended ones', () => {
    const out = sortRoutines([
      routine('ended', 'ENDED', null, '2026-09-26T10:00:00+06:00'),
      routine(
        'paused',
        'PAUSED',
        '2026-11-01T10:00:00+06:00',
        '2026-09-01T10:00:00+06:00',
      ),
      routine(
        'active',
        'ACTIVE',
        '2026-10-20T11:00:00+06:00',
        '2026-09-02T10:00:00+06:00',
      ),
    ]);
    expect(out.map((r) => r.id)).toEqual(['active', 'paused', 'ended']);
  });

  it('orders live routines by the soonest next visit, none last', () => {
    const out = sortRoutines([
      routine('none', 'ACTIVE', null, '2026-09-03T10:00:00+06:00'),
      routine(
        'later',
        'ACTIVE',
        '2026-10-27T11:00:00+06:00',
        '2026-09-01T10:00:00+06:00',
      ),
      routine(
        'sooner',
        'ACTIVE',
        '2026-10-20T11:00:00+06:00',
        '2026-09-02T10:00:00+06:00',
      ),
    ]);
    expect(out.map((r) => r.id)).toEqual(['sooner', 'later', 'none']);
  });

  it('compares next visits as instants, across offsets', () => {
    // 10:00 at +04:00 is 12:00 at +06:00, so it comes after 11:00 at +06:00.
    const out = sortRoutines([
      routine(
        'dubai',
        'ACTIVE',
        '2026-10-20T10:00:00+04:00',
        '2026-09-01T10:00:00+06:00',
      ),
      routine(
        'dhaka',
        'ACTIVE',
        '2026-10-20T11:00:00+06:00',
        '2026-09-01T10:00:00+06:00',
      ),
    ]);
    expect(out.map((r) => r.id)).toEqual(['dhaka', 'dubai']);
  });

  it('orders ended routines newest first', () => {
    const out = sortRoutines([
      routine('old', 'ENDED', null, '2026-08-01T10:00:00+06:00'),
      routine('new', 'ENDED', null, '2026-09-26T19:05:19+06:00'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('leaves the input as it was', () => {
    const input = [
      routine('b', 'ENDED', null, '2026-08-01T10:00:00+06:00'),
      routine(
        'a',
        'ACTIVE',
        '2026-10-20T11:00:00+06:00',
        '2026-09-01T10:00:00+06:00',
      ),
    ];
    sortRoutines(input);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('routineRow: what a Recurring tab row carries', () => {
  it('keeps the summary fields and drops the per-visit detail', () => {
    const hub = {
      id: 'c07d1528-2d6c-4d45-9494-e2f13e3cc79f',
      booking_type: 'ROUTINE',
      salon_id: 'c6c248ab-f2cd-4f12-a31e-243c6e64b3b5',
      status: 'ACTIVE',
      frequency: 'WEEKLY',
      time: '11:00',
      stylist: { id: 's', name: 'Ethan Walker' },
      services: [{ id: 'f', name: 'Hair Cut' }],
      payment_plan: 'PAY_AT_SALON',
      counts: { total: 2, done: 0, remaining: 2, skipped: 0, cancelled: 0 },
      next_session: { start_time: '2026-10-20T11:00:00+06:00' },
      created_at: '2026-09-26T19:05:19+06:00',
      sessions: [{}, {}],
      money: { total: 10.5, pay_now: 0 },
      can: { skip: true },
      rules: { lock_hours: 24 },
      pause: null,
    };
    const row = routineRow(hub);
    expect(Object.keys(row)).toEqual([...ROUTINE_ROW_FIELDS]);
    expect(row).not.toHaveProperty('sessions');
    expect(row.next_session).toEqual(hub.next_session);
  });
});
