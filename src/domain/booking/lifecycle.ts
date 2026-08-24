import { Money } from '../shared/money';

/**
 * A booking is a thing that moves through states, and only some moves are legal.
 *
 * Completing before starting, checking in a cancelled visit, confirming an
 * expired hold: all of those are rejected here rather than half-applied and
 * discovered later. The client mirrors state for a clean experience; this
 * file decides it.
 */

export type BookingStatus =
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
  | 'rescheduled'
  | 'expired'
  | 'skipped';

export type ActorKind = 'customer' | 'staff' | 'manager' | 'system';

/**
 * THE MOST LOAD-BEARING PREDICATE IN THE ENGINE.
 *
 * A blocking booking still occupies staff time and a chair. Every mask, every
 * capacity count, every re-validation and every group plan filters through
 * this. Get it wrong in one direction and you oversell; wrong in the other
 * and you refuse slots that are genuinely free.
 *
 * Note that Completed and Settled still block. The visit is over, but it
 * happened, and pretending the time was free would let a backdated booking
 * land on top of it.
 */
export const BLOCKING_STATES: ReadonlySet<BookingStatus> = new Set([
  'pending_payment',
  'pending_confirmation',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

/** The four exits. Capacity returns the instant one of these is reached. */
export const RELEASING_STATES: ReadonlySet<BookingStatus> = new Set([
  'cancelled',
  'no_show',
  'expired',
  'skipped',
]);

export function isBlocking(status: BookingStatus): boolean {
  return BLOCKING_STATES.has(status);
}

/** Reaching one of these is what wakes the waitlist. */
export function releasesCapacity(status: BookingStatus): boolean {
  return RELEASING_STATES.has(status);
}

/** Nothing moves out of a terminal state. */
export const TERMINAL_STATES: ReadonlySet<BookingStatus> = new Set([
  'settled',
  'cancelled',
  'no_show',
  'rescheduled',
  'expired',
  'skipped',
]);

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export interface Transition {
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly trigger: string;
  /** A privileged move that must say why. Written to the audit log. */
  readonly requiresReason: boolean;
  readonly allowedActors: readonly ActorKind[];
}

const ANY_STAFF: readonly ActorKind[] = ['staff', 'manager'];
const SYSTEM: readonly ActorKind[] = ['system'];

/**
 * The complete legal set. Anything not listed here is rejected.
 *
 * Written as data rather than a switch, so the rules can be read, tested and
 * rendered as a diagram without anyone tracing control flow.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'draft',
    to: 'held',
    trigger: 'slot selected',
    requiresReason: false,
    allowedActors: ['customer', ...ANY_STAFF],
  },
  {
    from: 'held',
    to: 'confirmed',
    trigger: 'requirement met',
    requiresReason: false,
    allowedActors: ['customer', ...ANY_STAFF],
  },
  {
    from: 'held',
    to: 'pending_payment',
    trigger: 'payment link sent',
    requiresReason: false,
    allowedActors: ANY_STAFF,
  },
  {
    from: 'held',
    to: 'expired',
    trigger: 'TTL lapsed',
    requiresReason: false,
    allowedActors: SYSTEM,
  },

  {
    from: 'pending_payment',
    to: 'confirmed',
    trigger: 'link paid',
    requiresReason: false,
    allowedActors: ['customer', 'system'],
  },
  {
    from: 'pending_payment',
    to: 'expired',
    trigger: 'window lapsed',
    requiresReason: false,
    allowedActors: SYSTEM,
  },
  {
    from: 'pending_payment',
    to: 'cancelled',
    trigger: 'cancel',
    requiresReason: true,
    allowedActors: ['customer', ...ANY_STAFF],
  },

  {
    from: 'pending_confirmation',
    to: 'confirmed',
    trigger: 'customer confirmed',
    requiresReason: false,
    allowedActors: ['customer'],
  },
  {
    from: 'pending_confirmation',
    to: 'expired',
    trigger: '48 hours passed',
    requiresReason: false,
    allowedActors: SYSTEM,
  },
  {
    from: 'pending_confirmation',
    to: 'skipped',
    trigger: 'skip',
    requiresReason: true,
    allowedActors: ['customer', ...ANY_STAFF],
  },

  {
    from: 'confirmed',
    to: 'checked_in',
    trigger: 'arrival',
    requiresReason: false,
    allowedActors: ANY_STAFF,
  },
  {
    from: 'confirmed',
    to: 'cancelled',
    trigger: 'cancel',
    requiresReason: true,
    allowedActors: ['customer', ...ANY_STAFF],
  },
  {
    from: 'confirmed',
    to: 'no_show',
    trigger: 'grace elapsed',
    requiresReason: false,
    allowedActors: [...ANY_STAFF, 'system'],
  },
  {
    from: 'confirmed',
    to: 'rescheduled',
    trigger: 'moved',
    requiresReason: true,
    allowedActors: ['customer', ...ANY_STAFF],
  },

  {
    from: 'checked_in',
    to: 'in_service',
    trigger: 'start',
    requiresReason: false,
    allowedActors: ANY_STAFF,
  },
  {
    from: 'checked_in',
    to: 'cancelled',
    trigger: 'cancel',
    requiresReason: true,
    allowedActors: ANY_STAFF,
  },
  {
    from: 'checked_in',
    to: 'no_show',
    trigger: 'never started',
    requiresReason: true,
    allowedActors: ANY_STAFF,
  },

  {
    from: 'in_service',
    to: 'completed',
    trigger: 'complete',
    requiresReason: false,
    allowedActors: ANY_STAFF,
  },
  {
    from: 'completed',
    to: 'settled',
    trigger: 'POS payment',
    requiresReason: false,
    allowedActors: ANY_STAFF,
  },
];

const LEGAL: ReadonlyMap<BookingStatus, ReadonlySet<BookingStatus>> = (() => {
  const m = new Map<BookingStatus, Set<BookingStatus>>();
  for (const t of TRANSITIONS) {
    const set = m.get(t.from) ?? new Set<BookingStatus>();
    set.add(t.to);
    m.set(t.from, set);
  }
  return m;
})();

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return LEGAL.get(from)?.has(to) === true;
}

/** Everywhere this booking could go next. Drives which buttons are enabled. */
export function nextStates(from: BookingStatus): BookingStatus[] {
  return [...(LEGAL.get(from) ?? [])].sort();
}

export function findTransition(
  from: BookingStatus,
  to: BookingStatus,
): Transition | null {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export type TransitionVerdict =
  | { readonly kind: 'allowed'; readonly transition: Transition }
  | { readonly kind: 'illegal'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'needs_reason'; readonly message: string };

/**
 * One gate every lifecycle command runs before it writes anything.
 *
 * Illegal first, because "you cannot go there" beats "you are not allowed to",
 * which beats "you did not say why". Reversing that order tells a receptionist
 * to supply a reason for a move that could never have worked.
 */
export function checkTransition(input: {
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly actor: ActorKind;
  readonly reason?: string | null;
}): TransitionVerdict {
  const transition = findTransition(input.from, input.to);
  if (transition === null) {
    return {
      kind: 'illegal',
      message: `A ${input.from} booking cannot become ${input.to}.`,
    };
  }
  if (!transition.allowedActors.includes(input.actor)) {
    return {
      kind: 'forbidden',
      message: `A ${input.actor} may not ${transition.trigger}.`,
    };
  }
  if (transition.requiresReason && (input.reason ?? '').trim() === '') {
    return { kind: 'needs_reason', message: 'Choose a reason' };
  }
  return { kind: 'allowed', transition };
}

/** Check-in opens this many minutes before the start. */
export const CHECK_IN_OPENS_MIN = 30;
/** Grace after the start before the desk is prompted. */
export const ARRIVAL_GRACE_MIN = 15;
/** VIP and Royal get a longer grace. */
export const VIP_ARRIVAL_GRACE_MIN = 20;
/** The desk owns the decision until this point, then the system acts. */
export const AUTO_NO_SHOW_MIN = 30;

export interface ArrivalWindow {
  readonly opensAtMin: number;
  readonly graceEndsAtMin: number;
  readonly autoNoShowAtMin: number;
}

export function arrivalWindow(startMin: number, isVip = false): ArrivalWindow {
  return {
    opensAtMin: startMin - CHECK_IN_OPENS_MIN,
    graceEndsAtMin:
      startMin + (isVip ? VIP_ARRIVAL_GRACE_MIN : ARRIVAL_GRACE_MIN),
    autoNoShowAtMin: startMin + AUTO_NO_SHOW_MIN,
  };
}

/** Three gates. All must be green before the desk can check anyone in. */
export interface CheckInGates {
  /** Consent on file, or a patch test on file, or a manager waiver. */
  readonly consentAndPatchTest: boolean;
  /** Nothing pending: the requirement was none, or the deposit is captured. */
  readonly paymentSettled: boolean;
  /** A free chair of the correct type has been picked. */
  readonly chairSelected: boolean;
}

export type CheckInVerdict =
  | { readonly kind: 'ready' }
  | { readonly kind: 'too_early'; readonly opensAtMin: number }
  | { readonly kind: 'gates_amber'; readonly amber: readonly string[] };

export function canCheckIn(input: {
  readonly gates: CheckInGates;
  readonly nowMin: number;
  readonly startMin: number;
  readonly isVip?: boolean;
}): CheckInVerdict {
  const window = arrivalWindow(input.startMin, input.isVip ?? false);
  if (input.nowMin < window.opensAtMin) {
    return { kind: 'too_early', opensAtMin: window.opensAtMin };
  }

  const amber: string[] = [];
  if (!input.gates.consentAndPatchTest) amber.push('consent and patch test');
  if (!input.gates.paymentSettled) amber.push('payment');
  if (!input.gates.chairSelected) amber.push('chair');

  return amber.length === 0
    ? { kind: 'ready' }
    : { kind: 'gates_amber', amber };
}

export type CancelInitiator = 'customer' | 'salon';

export type PolicyBand =
  | 'more_than_24h'
  | '24h_to_2h'
  | 'under_2h'
  | 'salon_initiated'
  | 'nothing_captured';

export interface MoneyOutcome {
  readonly refundFils: number;
  readonly keptFils: number;
  readonly band: PolicyBand;
  /** A late cancel weighs more in the risk score than an ordinary one. */
  readonly lateCancel: boolean;
  readonly explanation: string;
}

export interface CancellationInput {
  readonly nowMs: number;
  readonly startAtMs: number;
  readonly capturedFils: number;
  /** Full payment refunds differently from a deposit in the middle band. */
  readonly paidInFull: boolean;
  readonly initiatedBy: CancelInitiator;
}

const HOUR_MS = 60 * 60 * 1000;
export const LATE_CANCEL_WINDOW_HOURS = 2;
export const FREE_CANCEL_WINDOW_HOURS = 24;

/**
 * Computed BEFORE anything is applied, so the operator can read the outcome
 * to the customer before agreeing to it.
 *
 * The one rule that is unconditional: a salon-initiated cancellation always
 * refunds in full, whatever the timing. The customer did nothing wrong.
 */
export function cancellationOutcome(input: CancellationInput): MoneyOutcome {
  const captured = Money.fils(input.capturedFils);

  if (captured.isZero()) {
    return {
      refundFils: 0,
      keptFils: 0,
      band: 'nothing_captured',
      lateCancel: false,
      explanation: 'No charge. Any pending payment intent is voided.',
    };
  }

  if (input.initiatedBy === 'salon') {
    return {
      refundFils: captured.fils,
      keptFils: 0,
      band: 'salon_initiated',
      lateCancel: false,
      explanation: `Refunded in full (${captured.toString()}). The salon cancelled, so timing does not apply.`,
    };
  }

  const hoursAhead = (input.startAtMs - input.nowMs) / HOUR_MS;

  if (hoursAhead > FREE_CANCEL_WINDOW_HOURS) {
    return {
      refundFils: captured.fils,
      keptFils: 0,
      band: 'more_than_24h',
      lateCancel: false,
      explanation: `Refunded in full (${captured.toString()}) to the wallet.`,
    };
  }

  if (hoursAhead > LATE_CANCEL_WINDOW_HOURS) {
    // A deposit is kept whole. Full payment splits, because the salon has
    // less chance to resell but the customer has paid for the whole visit.
    if (input.paidInFull) {
      const refund = captured.percent(50);
      return {
        refundFils: refund.fils,
        keptFils: captured.minus(refund).fils,
        band: '24h_to_2h',
        lateCancel: false,
        explanation: `${refund.toString()} refunded, ${captured.minus(refund).toString()} kept per policy.`,
      };
    }
    return {
      refundFils: 0,
      keptFils: captured.fils,
      band: '24h_to_2h',
      lateCancel: false,
      explanation: `Deposit kept (${captured.toString()}) per policy.`,
    };
  }

  return {
    refundFils: 0,
    keptFils: captured.fils,
    band: 'under_2h',
    lateCancel: true,
    explanation: `Late cancel. ${captured.toString()} kept, and it weighs more in the risk score.`,
  };
}

export interface NoShowInput {
  readonly capturedFils: number;
  /** A VIP standing reservation has the fee waived by rule. */
  readonly vipStandingReservation?: boolean;
}

export function noShowOutcome(input: NoShowInput): MoneyOutcome {
  const captured = Money.fils(input.capturedFils);

  if (input.vipStandingReservation === true) {
    return {
      refundFils: captured.fils,
      keptFils: 0,
      band: 'salon_initiated',
      lateCancel: false,
      explanation:
        'VIP standing reservation. The no-show fee is waived by rule.',
    };
  }

  return {
    refundFils: 0,
    keptFils: captured.fils,
    band: 'under_2h',
    lateCancel: true,
    explanation: captured.isZero()
      ? 'No deposit was on file, so nothing is forfeited.'
      : `Forfeited (${captured.toString()}). The risk score is updated.`,
  };
}

/**
 * Every money outcome must balance: what goes back plus what is kept equals
 * what was taken. Swept continuously in production; asserted in tests so a
 * policy edit cannot quietly invent or destroy money.
 */
export function balances(outcome: MoneyOutcome, capturedFils: number): boolean {
  return outcome.refundFils + outcome.keptFils === capturedFils;
}
