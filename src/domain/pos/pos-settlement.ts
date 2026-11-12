import type { DepositPosition } from '../journal/deposit-position';

/**
 * The ledger rows a POS payment leaves on a booking.
 *
 * The till has taken the balance and applied some of the deposit -- all of
 * it, or as much as the bill needed -- reversing the VAT on that part
 * (docs/booking-pos-tickets-plan.md §4). What is left here is to say so in
 * the deposit subledger, so the booking's balance lands on zero:
 *
 *   applied_at_pos  -applied, carrying the VAT the TILL reversed. The till
 *                   posted the draw-down itself; booking-api never posts
 *                   this row (journal-entry-plan.ts skips it).
 *   refunded        -leftover, credited to the wallet, carrying the deposit
 *                   VAT the till did NOT reverse. The journal posts it with
 *                   exactly that VAT (vat_fils), so CUSTOMER_DEPOSITS for the
 *                   booking ends at zero to the fil.
 *
 * Pure, so the arithmetic that decides what a customer is credited is tested
 * on its own (CLAUDE.md 1).
 */
export interface PosPaidDeposit {
  /** What the till applied, gross. */
  readonly appliedFils: number;
  /** The VAT the till reversed on it. */
  readonly appliedVatFils: number;
}

export interface SettlementRow {
  /** Negative, as stored. */
  readonly amountFils: number;
  readonly vatFils: number;
}

export type PosSettlementPlan =
  | {
      readonly kind: 'rows';
      readonly applied: SettlementRow | null;
      readonly leftover: SettlementRow | null;
    }
  | {
      readonly kind: 'refused';
      readonly code: 'INVALID_FIGURES' | 'DEPOSIT_EXCEEDS_BALANCE';
      readonly reason: string;
    };

export function planPosSettlement(
  position: DepositPosition,
  paid: PosPaidDeposit,
): PosSettlementPlan {
  const { appliedFils: applied, appliedVatFils: appliedVat } = paid;

  if (
    !Number.isInteger(applied) ||
    !Number.isInteger(appliedVat) ||
    applied < 0 ||
    appliedVat < 0 ||
    appliedVat > applied
  ) {
    return {
      kind: 'refused',
      code: 'INVALID_FIGURES',
      reason:
        `the till reported ${applied} fils applied with ${appliedVat} VAT; ` +
        'both must be whole fils, and the VAT no more than what was applied',
    };
  }

  // The till applied more than the booking holds. Writing it would take the
  // balance below zero -- money the customer never paid -- so it is refused
  // for a person to look at, never quietly clamped.
  if (applied > position.balanceFils) {
    return {
      kind: 'refused',
      code: 'DEPOSIT_EXCEEDS_BALANCE',
      reason:
        `the till applied ${applied} fils of deposit, but the booking holds ` +
        `${position.balanceFils}`,
    };
  }

  const leftover = position.balanceFils - applied;
  return {
    kind: 'rows',
    applied: applied > 0 ? { amountFils: -applied, vatFils: appliedVat } : null,
    leftover:
      leftover > 0
        ? {
            amountFils: -leftover,
            // What the till did not reverse, and never more than the row.
            vatFils: Math.min(
              leftover,
              Math.max(0, position.vatFils - appliedVat),
            ),
          }
        : null,
  };
}
