import { Injectable } from '@nestjs/common';
import { assessRisk, type CustomerHistory } from '@domain/booking/customer';
import {
  ANONYMOUS,
  type CustomerContext,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';

interface Seed {
  readonly tier: CustomerContext['tier'];
  readonly history: CustomerHistory;
  readonly requireDepositFlag?: boolean;
}

/**
 * Five customers chosen to exercise every rung, not to look realistic.
 *
 * The risk band is COMPUTED from history rather than written down, so the
 * fixture cannot drift away from the ladder the way a hand-set band would.
 */
const SEEDS: ReadonlyMap<string, Seed> = new Map([
  // Ordinary returning customer. Nothing fires but the service rule.
  [
    'dana',
    { tier: 'none', history: { noShows: 0, lateCancels: 0, visits: 6 } },
  ],

  // Gold: 10% off at CHECKOUT and not a fil off the deposit.
  [
    'nour',
    { tier: 'gold', history: { noShows: 0, lateCancels: 0, visits: 22 } },
  ],

  // The document's own worked example: two no-shows, four visits, score 28.
  [
    'omar',
    { tier: 'none', history: { noShows: 2, lateCancels: 0, visits: 4 } },
  ],

  // WATCH. Monitored, reminders intensify, and NOTHING is forced.
  [
    'yara',
    { tier: 'silver', history: { noShows: 0, lateCancels: 1, visits: 3 } },
  ],

  // A VIP a manager has flagged anyway. Proves tier rescues nobody.
  [
    'rania',
    {
      tier: 'vip',
      history: { noShows: 0, lateCancels: 0, visits: 40 },
      requireDepositFlag: true,
    },
  ],
]);

/**
 * Stands in for the customer service until the gRPC client exists.
 *
 * Swapping it changes ONE provider in the module. No handler, controller or
 * domain file is touched.
 */
@Injectable()
export class FixtureCustomerContext implements CustomerContextReader {
  load(customerId: string): Promise<CustomerContext> {
    const seed = SEEDS.get(customerId);
    if (seed === undefined) {
      // An id nobody knows is not an error at the desk: it is a walk-in the
      // receptionist typed a name for. New, so rung 4a fires.
      return Promise.resolve({ ...ANONYMOUS, customerId });
    }

    const risk = assessRisk(seed.history);
    return Promise.resolve({
      customerId,
      tier: seed.tier,
      risk: risk.band,
      riskScore: risk.score,
      isNewCustomer: seed.history.visits === 0,
      requireDepositFlag: seed.requireDepositFlag ?? false,
      isVip: seed.tier === 'vip' || seed.tier === 'royal',
    });
  }
}
