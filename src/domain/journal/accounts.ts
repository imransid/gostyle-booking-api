/**
 * The general-ledger accounts booking money posts to, by the platform's
 * system key.
 *
 * A system key, never a code or a name: a salon may rename "Customer
 * Deposits" or recode it from 2300, and the key survives both. The platform
 * refuses a key it does not know (INVALID_ARGUMENT), so a posting naming one
 * of the five below parks until the platform seeds it -- nothing is lost.
 *
 * THE ONLY PLACE THESE STRINGS ARE SPELLED (CLAUDE.md 4).
 */
export const Account = {
  // Seeded by the platform today.
  UNDEPOSITED_FUNDS: 'UNDEPOSITED_FUNDS',
  SALES_TAX_PAYABLE: 'SALES_TAX_PAYABLE',
  SERVICE_INCOME: 'SERVICE_INCOME',
  CUSTOMER_GOODWILL: 'CUSTOMER_GOODWILL',

  // Owed by the platform (docs/journal-integration.md lists code, name, kind).
  /** LIABILITY 2300. What the salon holds against bookings: deposit_ledger in the GL. */
  CUSTOMER_DEPOSITS: 'CUSTOMER_DEPOSITS',
  /** LIABILITY 2310. Credit owed to customers in their wallet. */
  CUSTOMER_WALLET: 'CUSTOMER_WALLET',
  /** INCOME 4020. Forfeited deposits: late cancellations, no-shows, late moves. */
  CANCELLATION_FEE_INCOME: 'CANCELLATION_FEE_INCOME',
  /** ASSET 1030. Desk cash outside the till, so the drawer count stays true. */
  FRONT_DESK_CASH: 'FRONT_DESK_CASH',
  /** ASSET 1060. Money in by a method nobody named, waiting to be reclassified. */
  PAYMENTS_CLEARING: 'PAYMENTS_CLEARING',
} as const;

export type AccountKey = (typeof Account)[keyof typeof Account];
