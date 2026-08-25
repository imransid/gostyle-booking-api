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
