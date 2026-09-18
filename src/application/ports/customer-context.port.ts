import type { RiskBand, Tier } from '@domain/booking/customer';

/**
 * Who this customer is, as far as the booking module needs to know.
 *
 * Deliberately small. The customer service owns names, phone numbers,
 * addresses and preferences; none of that changes what a booking costs or
 * whether a slot can be held. These six fields do.
 */
export interface CustomerContext {
  readonly customerId: string;
  /**
   * WHAT TO PRINT ON THE ROW. Null when nobody can tell us.
   *
   * Added against the port's own instinct -- "the customer service owns
   * names" is still true -- because the consequence of NOT publishing one
   * turned out to be worse than the coupling. No read model carried a name:
   * not the list, not the calendar day or week, not the events feed, not the
   * series board, not the walk-in queue. The console joined against the
   * platform customers API instead, which knows one of the twenty-one
   * customers these bookings belong to, so thirteen of the twenty-five rows
   * on page one rendered as "#127B" and every mount fired forty doomed
   * lookups.
   *
   * A name is decoration and this module still decides nothing with it, so
   * null is a legal answer everywhere and no caller may depend on it. But it
   * is decoration on every screen a human looks at, and it belongs in the
   * payload the screen already fetches rather than in a second round trip
   * per row.
   *
   * POPULATING IT NEEDS A CUSTOMER DIRECTORY over gRPC -- the same shape as
   * ListStylists and ListServices. See docs/api/PLATFORM-ASKS-BOOKING-CONTEXT.md.
   * Until that exists the fixture answers for its own seeds and every real
   * customer is null, which is at least a null the client can branch on.
   */
  readonly name: string | null;
  readonly tier: Tier;
  readonly risk: RiskBand;
  readonly riskScore: number;
  /** Rung 4a. True until they have completed a visit. */
  readonly isNewCustomer: boolean;
  /** Rung 2. Set by a manager on the customer record; forces at least 50%. */
  readonly requireDepositFlag: boolean;
  /** Arrival grace is longer for VIP, and the no-show fee can be waived. */
  readonly isVip: boolean;
}

/**
 * The default for a walk-in nobody has identified yet.
 *
 * NEW, not trusted. A quick-added person with only a name is treated as a
 * first-visit customer, so rung 4a fires and at least 20% is taken. That is
 * the safe direction: an unknown person is the one most likely not to
 * return, and the deposit is what protects the slot.
 */
export const ANONYMOUS: CustomerContext = {
  customerId: 'anonymous',
  name: null,
  tier: 'none',
  risk: 'LOW',
  riskScore: 80,
  isNewCustomer: true,
  requireDepositFlag: false,
  isVip: false,
};

/**
 * One method, because the booking module only ever asks one question:
 * who am I dealing with?
 */
export interface CustomerContextReader {
  load(customerId: string): Promise<CustomerContext>;
}

export const CUSTOMER_CONTEXT = Symbol('CUSTOMER_CONTEXT');
