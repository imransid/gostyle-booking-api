/**
 * The group's status, derived from its participants.
 *
 * NEVER SET DIRECTLY. A stored group status and a set of participant statuses
 * are two facts that can disagree, and when they do the stored one is always
 * the wrong one: it was written by whoever last remembered to update it.
 * Deriving it means the question "is this party confirmed?" has exactly one
 * answer, computed from the lanes that actually exist.
 */

export type ParticipantStatus =
  | 'draft'
  | 'held'
  | 'pending_payment'
  | 'pending_confirmation'
  | 'confirmed'
  | 'checked_in'
  | 'in_service'
  | 'completed'
  | 'settled'
  | 'cancelled'
  | 'no_show'
  | 'expired'
  | 'skipped';

export type GroupStatus =
  | 'draft'
  | 'partially_confirmed'
  | 'confirmed'
  | 'in_service'
  | 'completed'
  | 'cancelled';

/** A participant who has left the party, one way or another. */
const TERMINAL = new Set<ParticipantStatus>([
  'cancelled',
  'no_show',
  'expired',
  'skipped',
  'completed',
  'settled',
]);

/** Gone, rather than finished. These stop counting toward the party. */
const GONE = new Set<ParticipantStatus>([
  'cancelled',
  'no_show',
  'expired',
  'skipped',
]);

const AWAITING = new Set<ParticipantStatus>([
  'draft',
  'held',
  'pending_payment',
  'pending_confirmation',
]);

const READY = new Set<ParticipantStatus>([
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

export interface GroupDerivation {
  readonly status: GroupStatus;
  /** Participants who have not left. */
  readonly activeCount: number;
  /**
   * The party has fallen below two and should convert to a single booking.
   *
   * A "group" of one is a booking with extra machinery: split payments that
   * split nothing, a party planner matching one person against themselves,
   * and a status derived from a single lane. Converting is not tidying, it is
   * removing a lie.
   */
  readonly shouldConvertToSingle: boolean;
  readonly explanation: string;
}

export function deriveGroupStatus(
  participants: readonly ParticipantStatus[],
): GroupDerivation {
  const active = participants.filter((s) => !GONE.has(s));

  if (active.length === 0) {
    return {
      status: 'cancelled',
      activeCount: 0,
      shouldConvertToSingle: false,
      explanation:
        participants.length === 0
          ? 'Every participant has left. The party is cancelled.'
          : 'Every participant has left. The party is cancelled.',
    };
  }

  const status = statusOf(active);

  return {
    status,
    activeCount: active.length,
    // Only worth converting while the visit is still ahead. A party that has
    // already started, or finished, is history and history is not rewritten.
    shouldConvertToSingle:
      active.length === 1 &&
      (status === 'confirmed' ||
        status === 'partially_confirmed' ||
        status === 'draft'),
    explanation: explain(status, active.length, participants.length),
  };
}

function statusOf(active: readonly ParticipantStatus[]): GroupStatus {
  // ANY participant in service makes the party in service. The salon is
  // working on this group, whatever the others are doing.
  if (active.some((s) => s === 'in_service' || s === 'checked_in')) {
    return 'in_service';
  }

  // Completed when ALL have reached a terminal state and AT LEAST ONE
  // completed. A party where everyone cancelled is not completed, it is
  // cancelled, and the difference matters to every report that counts visits.
  if (active.every((s) => TERMINAL.has(s))) {
    return active.some((s) => s === 'completed' || s === 'settled')
      ? 'completed'
      : 'cancelled';
  }

  if (active.every((s) => READY.has(s))) return 'confirmed';

  // Some are ready and some are not: shares are still landing.
  if (active.some((s) => READY.has(s))) return 'partially_confirmed';

  if (active.every((s) => AWAITING.has(s))) {
    return active.some((s) => s === 'pending_payment')
      ? 'partially_confirmed'
      : 'draft';
  }

  return 'draft';
}

function explain(
  status: GroupStatus,
  activeCount: number,
  totalCount: number,
): string {
  const left = totalCount - activeCount;
  const suffix =
    left === 0
      ? ''
      : ` ${left} ${left === 1 ? 'participant has' : 'participants have'} left the party.`;

  switch (status) {
    case 'confirmed':
      return `All ${activeCount} participants are confirmed.${suffix}`;
    case 'partially_confirmed':
      return `Waiting on some of the ${activeCount} participants.${suffix}`;
    case 'in_service':
      return `The party is in the salon.${suffix}`;
    case 'completed':
      return `The visit is finished.${suffix}`;
    case 'cancelled':
      return 'The party is cancelled.';
    case 'draft':
      return `Not yet confirmed.${suffix}`;
  }
}
