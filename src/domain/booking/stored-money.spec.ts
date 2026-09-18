import { describe, it, expect } from 'vitest';
import { storedTotalFils } from './stored-money';

/**
 * THE RULE `moneyFor` FALLS BACK ON, on its own.
 *
 * The bug: `GET /booking/:id` and `PATCH /booking/:id` both re-quoted the
 * booking, and the quote handler throws `Unknown service` for a service the
 * live catalogue cannot resolve — retired, renamed, moved branch, or simply
 * a request that arrived without the tenant the lookup needs. So a booking
 * that plainly existed, with money owed on it, answered
 * `404 BOOKING_NOT_FOUND` to both "show me my booking" and "here is the
 * payment", naming a service rather than admitting it could not price it.
 *
 * The arithmetic of the fallback is pinned here, away from Nest and Prisma,
 * because it decides what a customer is told they owe.
 */
describe('storedTotalFils', () => {
  it('rebuilds the total the customer agreed to', () => {
    // 350.00 + 17.50 tax, no discount -> 367.50, in fils.
    expect(
      storedTotalFils({ netFils: 35000, taxFils: 1750, discountFils: 0 }),
    ).toBe(36750);
  });

  it('takes the discount off', () => {
    expect(
      storedTotalFils({ netFils: 35000, taxFils: 1750, discountFils: 2000 }),
    ).toBe(34750);
  });

  it('treats missing tax and discount as zero, not as missing', () => {
    // These two columns are nullable for rows written before the breakdown
    // existed. A null there means "none", and only a null NET means the
    // breakdown is absent altogether.
    expect(
      storedTotalFils({ netFils: 35000, taxFils: null, discountFils: null }),
    ).toBe(35000);
  });

  it('is null when there is no stored breakdown at all', () => {
    /**
     * NULL RATHER THAN `price_fils`. The row's price is the NET total with
     * no VAT in it, so reporting it as the total would understate every
     * figure by the tax — and understating what someone owes is worse than
     * saying the number is unavailable. A payment is refused outright in
     * this case rather than checked against a number we do not have.
     */
    expect(
      storedTotalFils({ netFils: null, taxFils: 1750, discountFils: 0 }),
    ).toBeNull();
  });
});
