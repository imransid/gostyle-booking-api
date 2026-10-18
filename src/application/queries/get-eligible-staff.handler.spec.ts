import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { GetEligibleStaffHandler } from './get-eligible-staff.handler';
import {
  FixtureBookingContext,
  PACKAGES,
} from '@infrastructure/fixtures/fixture-booking-context';

/**
 * Stage 2 of the wizard: who may do the chosen basket. A package picked at
 * stage 1 was "Unknown service" here while every later stage sold it.
 */
const handler = new GetEligibleStaffHandler(new FixtureBookingContext(), {
  forBranch: () => Promise.resolve(PACKAGES),
} as never);

describe('who may do a basket holding a package', () => {
  it('asks about its parts, and answers for them', async () => {
    const view = await handler.execute({
      branchId: 'marina-walk',
      tradingDay: '2026-10-20',
      serviceIds: ['colour-and-finish'],
      preferredStaffId: null,
    });
    expect(view.serviceIds).toEqual(['full-colour', 'blow-dry']);
    expect(view.durationMin).toBe(170);
    expect(view.eligible.length + view.refused.length).toBeGreaterThan(0);
  });

  it('a hand-picked basket answers exactly as before', async () => {
    const view = await handler.execute({
      branchId: 'marina-walk',
      tradingDay: '2026-10-20',
      serviceIds: ['blow-dry'],
      preferredStaffId: null,
    });
    expect(view.serviceIds).toEqual(['blow-dry']);
  });

  it('still refuses an id that is neither', async () => {
    await expect(
      handler.execute({
        branchId: 'marina-walk',
        tradingDay: '2026-10-20',
        serviceIds: ['not-a-thing'],
        preferredStaffId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
