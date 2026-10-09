import { describe, expect, it } from 'vitest';
import {
  checkInOf,
  staffShortName,
  type HistoryEntry,
} from './check-in-attribution';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 11, 10, 24);
const LAYLA = '0192a3b4-0000-7000-8000-00000000aaaa';
const OMAR = '0192a3b4-0000-7000-8000-00000000bbbb';

let n = 0;
/** A history row, each a minute after the last. */
function row(over: Partial<HistoryEntry>): HistoryEntry {
  n += 1;
  return {
    fromStatus: null,
    toStatus: 'confirmed',
    atMs: T0 + n * MIN,
    actorKind: 'customer',
    actorId: null,
    via: null,
    ...over,
  };
}
const booked = () => row({ toStatus: 'confirmed' });
const checkedIn = (via: 'self' | 'staff' | null, id = LAYLA) =>
  row({
    fromStatus: 'confirmed',
    toStatus: 'checked_in',
    actorKind: 'staff',
    actorId: id,
    via,
  });
const undone = () =>
  row({
    fromStatus: 'checked_in',
    toStatus: 'confirmed',
    actorKind: 'staff',
    actorId: LAYLA,
  });
const moved = (from: HistoryEntry['toStatus'], to: HistoryEntry['toStatus']) =>
  row({ fromStatus: from, toStatus: to, actorKind: 'staff', actorId: OMAR });

describe('checkInOf: the check-in that stands', () => {
  it('none for a booking never checked in', () => {
    expect(checkInOf([])).toBeNull();
    expect(checkInOf([booked()])).toBeNull();
  });

  it('a desk check-in: when, STAFF, and who', () => {
    const at = checkedIn('staff');
    expect(checkInOf([booked(), at])).toEqual({
      atMs: at.atMs,
      via: 'staff',
      by: { kind: 'staff', id: LAYLA },
    });
  });

  it('an approved request: SELF, and who approved it', () => {
    expect(checkInOf([booked(), checkedIn('self')])).toMatchObject({
      via: 'self',
      by: { id: LAYLA },
    });
  });

  it('stands through the visit: started, completed, settled', () => {
    const at = checkedIn('self');
    const history = [
      booked(),
      at,
      moved('checked_in', 'in_service'),
      moved('in_service', 'completed'),
      moved('completed', 'settled'),
    ];
    // The visit's later moves are by others; the check-in is still Layla's.
    expect(checkInOf(history)).toEqual({
      atMs: at.atMs,
      via: 'self',
      by: { kind: 'staff', id: LAYLA },
    });
  });

  it('stands after a cancel or a no-show: they were checked in', () => {
    expect(
      checkInOf([
        booked(),
        checkedIn('staff'),
        moved('checked_in', 'cancelled'),
      ]),
    ).not.toBeNull();
    expect(
      checkInOf([booked(), checkedIn('staff'), moved('checked_in', 'no_show')]),
    ).not.toBeNull();
  });

  it('none once the desk undid it', () => {
    expect(checkInOf([booked(), checkedIn('self'), undone()])).toBeNull();
  });

  it('approved, undone, then the desk on its own: STAFF, by the desk, not SELF', () => {
    // The case a request alone would get wrong: an approved request is still
    // there, behind a check-in the desk did by itself.
    const again = checkedIn('staff', OMAR);
    expect(checkInOf([booked(), checkedIn('self'), undone(), again])).toEqual({
      atMs: again.atMs,
      via: 'staff',
      by: { kind: 'staff', id: OMAR },
    });
  });

  it('a check-in written before `via` was recorded: unknown, not staff', () => {
    expect(checkInOf([booked(), checkedIn(null)])).toMatchObject({
      via: null,
      by: { id: LAYLA },
    });
  });

  it('a manager is a desk member', () => {
    const at = row({
      fromStatus: 'confirmed',
      toStatus: 'checked_in',
      actorKind: 'manager',
      actorId: OMAR,
      via: 'staff',
    });
    expect(checkInOf([at])?.by).toEqual({ kind: 'manager', id: OMAR });
  });

  it('a row that names no desk member: nothing to look up', () => {
    for (const odd of [
      { actorKind: 'staff' as const, actorId: null },
      { actorKind: 'system' as const, actorId: null },
      { actorKind: 'customer' as const, actorId: LAYLA },
    ]) {
      const at = row({
        fromStatus: 'confirmed',
        toStatus: 'checked_in',
        via: 'staff',
        ...odd,
      });
      expect(checkInOf([at])).toMatchObject({ via: 'staff', by: null });
    }
  });
});

describe('staffShortName: the name on the welcome screen', () => {
  it('the first name and the initial of the last', () => {
    expect(staffShortName('Layla', 'Rahman')).toBe('Layla R.');
  });

  it('trims, squashes inner space, and upper-cases the initial', () => {
    expect(staffShortName('  Mary   Anne ', ' smith')).toBe('Mary Anne S.');
  });

  it('the last name as platform spells it: its first letter', () => {
    expect(staffShortName('Layla', 'Al Rashid')).toBe('Layla A.');
  });

  it('a script with no case keeps its letter', () => {
    expect(staffShortName('ليلى', 'رحمن')).toBe('ليلى ر.');
  });

  it('an initial outside the Basic Multilingual Plane is whole', () => {
    expect(staffShortName('Ada', '𝓛ovelace')).toBe('Ada 𝓛.');
  });

  it.each([null, undefined, '', '   '])(
    'no last name (%j): the first name alone',
    (last) => {
      expect(staffShortName('Layla', last)).toBe('Layla');
    },
  );

  it.each([
    [null, 'Rahman'],
    ['', 'Rahman'],
    ['  ', 'Rahman'],
    [undefined, undefined],
  ])(
    'no first name (%j, %j): null, an initial greets nobody',
    (first, last) => {
      expect(staffShortName(first, last)).toBeNull();
    },
  );
});
