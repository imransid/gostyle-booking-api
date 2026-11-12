import type { StoredBreakdown } from '../booking/stored-money';
import { splitOf, type LedgerEntryType } from './journal-entry-plan';

/**
 * What a booking's deposit is worth right now, and how much of it is VAT
 * the books have already declared.
 *
 * THE TILL NEEDS THE PAIR. When a booked customer pays at the POS, the till
 * applies the deposit as a draw-down and REVERSES the VAT that was declared
 * when the deposit was captured, then charges VAT on the whole ticket. That
 * nets to VAT counted once -- but only if the VAT it reverses is exactly the
 * VAT the books hold for this deposit. Off by a fil and CUSTOMER_DEPOSITS
 * never reaches zero for the booking.
 *
 * So the VAT is not re-derived from the balance (vatShare(SUM) can round a
 * fil away from the sum of the rows' own splits). It is the sum, row by row,
 * of the same split the journal posts each row with (splitOf): every row
 * that moved the deposit moved its VAT share with it.
 *
 *   captured, goodwill, reversed  +  the row's VAT share joins the deposit
 *   refunded, forfeited,          -  the row's VAT share leaves it (refunded
 *   course_draw, applied_at_pos      back to the customer, or consumed as
 *                                    income whose VAT was declared at capture)
 *
 * The sign comes from the stored amount, which the database already pins to
 * the entry type (deposit_ledger_sign_matches_type).
 */
export interface DepositRow {
  readonly entryType: LedgerEntryType;
  /** Signed, as stored. */
  readonly amountFils: number;
  readonly vatFils?: number | null;
}

export interface DepositPosition {
  /** SUM(amount_fils): what the salon holds against the booking. */
  readonly balanceFils: number;
  /** The VAT inside that balance, as the journal declared it. */
  readonly vatFils: number;
}

export function depositPosition(
  rows: readonly DepositRow[],
  breakdown: StoredBreakdown,
): DepositPosition {
  let balance = 0;
  let vat = 0;
  for (const row of rows) {
    if (row.amountFils === 0) continue;
    const sign = row.amountFils < 0 ? -1 : 1;
    balance += row.amountFils;
    vat += sign * splitOf(row, breakdown).vat;
  }
  // A ledger can only owe VAT on money it holds. Negative or larger than the
  // balance means rows the journal could never have posted that way; clamp
  // rather than ask the till to reverse VAT nobody declared.
  if (balance <= 0) return { balanceFils: Math.max(0, balance), vatFils: 0 };
  return { balanceFils: balance, vatFils: Math.min(Math.max(0, vat), balance) };
}
