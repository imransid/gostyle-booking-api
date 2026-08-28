import { describe, it, expect } from 'vitest';
import {
  gateFor,
  isSettled,
  stateAfter,
  type ItemState,
  type WorklistItem,
} from './roster-change';

const item = (id: string, state: ItemState): WorklistItem => ({
  id,
  bookingCode: `GS-${id}`,
  state,
});

describe('what counts as settled', () => {
  it('treats an open item as unsettled', () => {
    expect(isSettled('open')).toBe(false);
  });

  it('treats every resolution as settled', () => {
    for (const s of [
      'auto_repaired',
      'resolved',
      'overridden',
      'cancelled',
    ] as const) {
      expect(isSettled(s)).toBe(true);
    }
  });
});

describe('what a resolution does', () => {
  it('maps each resolution to its state', () => {
    expect(stateAfter('reassign')).toBe('resolved');
    expect(stateAfter('move')).toBe('resolved');
    expect(stateAfter('override')).toBe('overridden');
    expect(stateAfter('accept_cancellation')).toBe('cancelled');
  });

  it('produces a settled state whatever the resolution', () => {
    for (const r of [
      'reassign',
      'move',
      'override',
      'accept_cancellation',
    ] as const) {
      expect(isSettled(stateAfter(r))).toBe(true);
    }
  });
});

describe('the gate', () => {
  it('blocks while anything is open', () => {
    const gate = gateFor([item('1', 'open'), item('2', 'auto_repaired')]);
    expect(gate.status).toBe('blocked');
    expect(gate.mayCommit).toBe(false);
    expect(gate.open).toBe(1);
  });

  it('clears once every item is settled', () => {
    const gate = gateFor([item('1', 'resolved'), item('2', 'auto_repaired')]);
    expect(gate.status).toBe('clear');
    expect(gate.mayCommit).toBe(true);
  });

  it('clears an empty worklist: a harmless edit is not blocked on nothing', () => {
    const gate = gateFor([]);
    expect(gate.mayCommit).toBe(true);
    expect(gate.explanation).toMatch(/Nothing was affected/);
  });

  it('counts what the ladder handled without a human', () => {
    const gate = gateFor([
      item('1', 'auto_repaired'),
      item('2', 'auto_repaired'),
      item('3', 'resolved'),
    ]);
    expect(gate.autoRepaired).toBe(2);
    expect(gate.explanation).toMatch(/2 were repaired automatically/);
  });

  it('names the bookings still waiting', () => {
    const gate = gateFor([item('7', 'open'), item('8', 'resolved')]);
    expect(gate.awaitingCancellation).toEqual(['GS-7']);
  });

  it('a manager override clears an item like any other resolution', () => {
    // Override is a decision, not an escape hatch that leaves the item open.
    expect(gateFor([item('1', 'overridden')]).mayCommit).toBe(true);
  });

  it('an accepted cancellation clears the item', () => {
    expect(gateFor([item('1', 'cancelled')]).mayCommit).toBe(true);
  });

  it('reads singular and plural correctly', () => {
    expect(gateFor([item('1', 'open')]).explanation).toMatch(
      /1 of 1 booking still needs/,
    );
    expect(gateFor([item('1', 'open'), item('2', 'open')]).explanation).toMatch(
      /2 of 2 bookings still need/,
    );
  });

  it('never claims commit while one stubborn item remains', () => {
    const many: WorklistItem[] = [
      ...Array.from({ length: 20 }, (_, i) => item(String(i), 'resolved')),
      item('last', 'open'),
    ];
    expect(gateFor(many).mayCommit).toBe(false);
    expect(gateFor(many).open).toBe(1);
  });
});
