import { afterEach, describe, it, expect, vi } from 'vitest';
import { MobilePaymentRepository } from './mobile-payment.repository';

const BOOKING = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

/** Just enough of Prisma for one recorded payment: the booking row locked,
 *  then the writes, in one transaction. */
function setup(status = 'pending_payment') {
  const tx = {
    $queryRaw: vi.fn(() =>
      Promise.resolve([
        {
          id: BOOKING,
          status,
          payment_status: 'unpaid',
          link_expires_at: null,
        },
      ]),
    ),
    depositLedger: { create: vi.fn(() => Promise.resolve({ id: 'entry-1' })) },
    $executeRawUnsafe: vi.fn(() => Promise.resolve(1)),
    bookingStatusHistory: { create: vi.fn(() => Promise.resolve({})) },
    eventOutbox: { create: vi.fn((_a: unknown) => Promise.resolve({})) },
  };
  const prisma = {
    depositLedger: { findFirst: vi.fn(() => Promise.resolve(null)) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const repo = new MobilePaymentRepository(prisma as never);
  const record = () =>
    repo.record({
      bookingId: BOOKING,
      customerId: CUSTOMER,
      amountFils: 21000,
      rail: 'card',
      reference: 'pay-1',
      paymentStatus: 'fully_paid',
    });
  return { tx, record };
}

const saved = process.env.MOBILE_NOTIFY_HUB;
afterEach(() => {
  if (saved === undefined) delete process.env.MOBILE_NOTIFY_HUB;
  else process.env.MOBILE_NOTIFY_HUB = saved;
});

describe('MobilePaymentRepository and the Notification Center', () => {
  it('MOBILE_NOTIFY_HUB on: the payment that confirms writes booking.payment_recorded in its transaction', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { tx, record } = setup();

    expect((await record()).kind).toBe('recorded');

    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'booking',
        aggregateId: BOOKING,
        eventType: 'booking.payment_recorded',
        payload: { paymentStatus: 'fully_paid' },
      },
    });
  });

  it('off: no event, exactly as before', async () => {
    delete process.env.MOBILE_NOTIFY_HUB;
    const { tx, record } = setup();
    await record();
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('on, but the booking was already confirmed: nothing new to tell', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { tx, record } = setup('confirmed');
    await record();
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });
});
