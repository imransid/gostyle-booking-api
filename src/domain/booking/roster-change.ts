/**
 * The commit gate.
 *
 * "The roster edit that caused the disruption cannot be committed while the
 * worklist is non-empty." That sentence is a GUARANTEE, and a guarantee
 * enforced by whoever remembers to check is a convention. So the change
 * itself becomes a record here, the worklist hangs off it, and "may this
 * commit?" is a question with one answer computed from the items that exist.
 *
 * Derived, never stored as a flag. The same reasoning as the group's status
 * and the series' health: a stored `committable` boolean and a set of item
 * states are two facts that can disagree, and the stored one is always the
 * one that is wrong.
 */

export type RosterChangeKind =
  /** A professional is deactivated or their shift is edited over bookings. */
  | 'shift_conflict'
  /** A day is closed: a holiday, a private event. */
  | 'closure_sweep'
  /** A chair breaks mid-day. */
  | 'chair_out_of_service';

export type ItemState =
  /** The ladder has not run, or it ran and a human is still needed. */
  | 'open'
  /** Rungs 1-3 moved it. Nothing further is required. */
  | 'auto_repaired'
  /** A human reassigned or moved it by hand. */
  | 'resolved'
  /** A manager accepted the consequence and cleared it deliberately. */
  | 'overridden'
  /** The proposed salon cancellation was accepted and applied. */
  | 'cancelled';

/** Everything that is no longer waiting on anybody. */
const SETTLED: ReadonlySet<ItemState> = new Set<ItemState>([
  'auto_repaired',
  'resolved',
  'overridden',
  'cancelled',
]);

export function isSettled(state: ItemState): boolean {
  return SETTLED.has(state);
}

export type Resolution =
  'reassign' | 'move' | 'override' | 'accept_cancellation';

/** Which state a resolution puts an item into. */
export function stateAfter(resolution: Resolution): ItemState {
  switch (resolution) {
    case 'reassign':
    case 'move':
      return 'resolved';
    case 'override':
      return 'overridden';
    case 'accept_cancellation':
      return 'cancelled';
  }
}

export interface WorklistItem {
  readonly id: string;
  readonly bookingCode: string;
  readonly state: ItemState;
}

export type GateStatus = 'blocked' | 'clear';

export interface Gate {
  readonly status: GateStatus;
  /** True only when nothing is waiting. The roster service asks this. */
  readonly mayCommit: boolean;
  readonly total: number;
  readonly open: number;
  readonly autoRepaired: number;
  readonly awaitingCancellation: readonly string[];
  readonly explanation: string;
}

/**
 * May the roster edit commit?
 *
 * An EMPTY worklist is clear. A change that disturbed nobody is not blocked
 * on anything, and treating "no items" as "not yet assessed" would deadlock
 * every harmless roster edit the salon ever makes.
 */
export function gateFor(items: readonly WorklistItem[]): Gate {
  const open = items.filter((i) => !isSettled(i.state));
  const autoRepaired = items.filter((i) => i.state === 'auto_repaired');

  return {
    status: open.length === 0 ? 'clear' : 'blocked',
    mayCommit: open.length === 0,
    total: items.length,
    open: open.length,
    autoRepaired: autoRepaired.length,
    awaitingCancellation: open.map((i) => i.bookingCode),
    explanation: explain(items.length, open.length, autoRepaired.length),
  };
}

function explain(total: number, open: number, autoRepaired: number): string {
  if (total === 0) {
    return 'Nothing was affected. The roster edit may commit.';
  }
  if (open === 0) {
    const repaired =
      autoRepaired === 0
        ? ''
        : ` ${autoRepaired} ${autoRepaired === 1 ? 'was' : 'were'} repaired automatically.`;
    return `All ${total} ${total === 1 ? 'booking is' : 'bookings are'} settled. The roster edit may commit.${repaired}`;
  }
  return (
    `${open} of ${total} ${open === 1 ? 'booking' : 'bookings'} still ` +
    `${open === 1 ? 'needs' : 'need'} a decision. The roster edit is blocked.`
  );
}
