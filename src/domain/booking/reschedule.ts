import { Money } from '../shared/money';
import { LATE_CANCEL_WINDOW_HOURS } from './lifecycle';

/**
 * Moving a booking.
 *
 * The booking is MOVED, not replaced: same row, same code, new time, move
 * counter up by one. That matters for the money, because a deposit attached
 * to a booking that still exists does not need refunding and re-taking.
 */

const HOUR_MS = 60 * 60 * 1000;

/** From this move onward, a free booking acquires a deposit. */
export const SERIAL_MOVE_THRESHOLD = 4;
export const SERIAL_MOVE_PERCENT = 20;

export interface RescheduleInput {
  readonly nowMs: number;
  /** The start it is moving AWAY from. Policy is judged on the old time. */
  readonly currentStartAtMs: number;
  readonly capturedFils: number;
  readonly totalFils: number;
  /** Moves already made. The fourth is the one that bites. */
  readonly moveCount: number;
}

export type MoneyMove =
  /** The deposit stays where it is, attached to the same booking. */
  | { readonly kind: 'carries'; readonly amountFils: number }
  /**
   * Inside the late window the move is a late cancel plus a new booking, so
   * the old money is forfeited and the requirement is resolved fresh.
   */
  | { readonly kind: 'forfeit_and_requote'; readonly forfeitedFils: number };

export interface RescheduleOutcome {
  readonly money: MoneyMove;
  readonly lateMove: boolean;
  readonly newMoveCount: number;
  /**
   * Set when the serial-rescheduler rule bites: a booking with no deposit
   * acquires one, a payment link goes out, and it holds as PendingPayment
   * until paid.
   */
  readonly acquiresDepositFils: number | null;
  readonly explanation: string;
}

/**
 * What a move costs, decided before anything is applied.
 *
 * Two rules, and the second is the interesting one.
 *
 * WITHIN POLICY the money carries untouched. Refunding a deposit and taking
 * an identical one back is two gateway round trips, two ledger entries and a
 * window where the slot is unprotected, to arrive exactly where it started.
 *
 * FROM THE FOURTH MOVE a booking carrying no deposit acquires a 20% one.
 * Unlimited free moves are functionally identical to holding a slot hostage.
 * The rule attaches to the BOOKING rather than the person, so an unlucky
 * customer with one difficult week is not punished for it later.
 */
export function rescheduleOutcome(input: RescheduleInput): RescheduleOutcome {
  const captured = Money.fils(input.capturedFils);
  const hoursAhead = (input.currentStartAtMs - input.nowMs) / HOUR_MS;
  const lateMove = hoursAhead < LATE_CANCEL_WINDOW_HOURS;
  const newMoveCount = input.moveCount + 1;

  if (lateMove) {
    return {
      money: { kind: 'forfeit_and_requote', forfeitedFils: captured.fils },
      lateMove: true,
      newMoveCount,
      acquiresDepositFils: null,
      explanation: captured.isZero()
        ? `Moved inside the ${LATE_CANCEL_WINDOW_HOURS}-hour window. Nothing was captured, and the new time is quoted fresh.`
        : `Moved inside the ${LATE_CANCEL_WINDOW_HOURS}-hour window, so this counts as a late cancel. ${captured.toString()} is forfeited and the new time is quoted fresh.`,
    };
  }

  // The serial-rescheduler rule only reaches a booking with nothing at stake.
  const acquires =
    newMoveCount >= SERIAL_MOVE_THRESHOLD && captured.isZero()
      ? Money.fils(input.totalFils)
          .percent(SERIAL_MOVE_PERCENT)
          .roundToDirhams()
      : null;

  if (acquires !== null) {
    return {
      money: { kind: 'carries', amountFils: 0 },
      lateMove: false,
      newMoveCount,
      acquiresDepositFils: acquires.fils,
      explanation: `Move ${newMoveCount}. A ${SERIAL_MOVE_PERCENT}% deposit of ${acquires.toString()} is now required, and a payment link has been sent.`,
    };
  }

  return {
    money: { kind: 'carries', amountFils: captured.fils },
    lateMove: false,
    newMoveCount,
    acquiresDepositFils: null,
    explanation: captured.isZero()
      ? 'Moved within policy. Nothing was captured, so nothing changes.'
      : `Moved within policy. ${captured.toString()} carries to the new time untouched.`,
  };
}
