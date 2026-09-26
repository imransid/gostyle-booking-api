import { describe, expect, it, vi } from 'vitest';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  MobileSeriesController,
  type MobileSeriesDto,
} from './mobile-series.controller';
import { MobileSeriesEnabledGuard } from './mobile-series.flag';
import { IdempotentInterceptor } from './idempotent.interceptor';
import type { Actor } from '../../auth/actor';

/**
 * CONTROLLER SPEC: the edge only. The body becomes the command in our
 * words, the flag guards every route, and a retried create replays.
 */

const actor: Actor = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'customer',
  branchId: null,
  tenantId: null,
};

const body = (over: Partial<MobileSeriesDto> = {}): MobileSeriesDto => ({
  salon_id: 'marina-walk',
  services: [{ id: 'haircut-finish' }],
  stylist_id: 'maya',
  frequency: 'WEEKLY',
  start_date: '2026-10-06',
  sessions: 3,
  time: '16:30',
  payment_plan: 'PAY_AT_SALON',
  ...over,
});

function harness() {
  const handler = {
    execute: vi.fn((_cmd: unknown) => Promise.resolve({ ok: true })),
  };
  const reads = { read: vi.fn(() => Promise.resolve({ id: 'series-1' })) };
  const res = { status: vi.fn() };
  const controller = new MobileSeriesController(
    handler as never,
    reads as never,
  );
  return { controller, handler, reads, res };
}

describe('MobileSeriesController', () => {
  it('every route is behind MOBILE_SERIES_BOOKING (off: 404)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      MobileSeriesController,
    ) as unknown[];
    expect(guards).toContain(MobileSeriesEnabledGuard);
  });

  it('a retried create with the same Idempotency-Key replays the routine', () => {
    const interceptors = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      MobileSeriesController,
    ) as unknown[];
    expect(interceptors).toContain(IdempotentInterceptor);
  });

  it('turns the body into the command, the customer from the token', async () => {
    const { controller, handler, res } = harness();
    await controller.create(
      body({
        picks: [{ index: 1, date: '2026-10-13', time: '17:00' }],
        products: [{ id: 'pomade-100', amount: 20 }],
        amount_without_tax: 300,
        tax_amount: 15,
        discount: 0,
        total: 315,
      }),
      actor,
      res as never,
    );
    expect(handler.execute).toHaveBeenCalledWith({
      salonId: 'marina-walk',
      customerId: actor.id,
      claim: {
        dryRun: false,
        serviceIds: ['haircut-finish'],
        stylistId: 'maya',
        frequency: 'WEEKLY',
        startDate: '2026-10-06',
        sessions: 3,
        dates: null,
        time: '16:30',
        paymentPlan: 'PAY_AT_SALON',
        picks: [
          { index: 1, date: '2026-10-13', time: '17:00', stylistId: null },
        ],
      },
      products: [{ id: 'pomade-100', amount: 20 }],
      money: { amountWithoutTax: 300, taxAmount: 15, discount: 0, total: 315 },
      depositPercent: 20,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('a dry_run answers 200, and may leave the figures out', async () => {
    const { controller, handler, res } = harness();
    await controller.create(body({ dry_run: true }), actor, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(handler.execute.mock.calls[0]![0]).toMatchObject({
      claim: { dryRun: true },
      money: null,
    });
  });

  it('a figure left out of a create is sent as missing, to be refused with the right one', async () => {
    const { controller, handler, res } = harness();
    await controller.create(body({ total: 315 }), actor, res as never);
    const money = (
      handler.execute.mock.calls[0]![0] as {
        money: Record<string, number>;
      }
    ).money;
    expect(money.total).toBe(315);
    expect(Number.isNaN(money.amountWithoutTax)).toBe(true);
  });

  it('the hub is read as the caller', async () => {
    const { controller, reads } = harness();
    await controller.read('series-1', actor);
    expect(reads.read).toHaveBeenCalledWith('series-1', {
      actorId: actor.id,
      actorKind: 'customer',
      actorBranchId: null,
    });
  });
});
