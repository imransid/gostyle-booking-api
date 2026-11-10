import { describe, it, expect } from 'vitest';
import {
  buildOpenRequest,
  buildStatusRequest,
  openStillWanted,
  posSyncOf,
  voidsTicket,
  type BookingForPos,
} from './pos-ticket-request';

const BOOKING: BookingForPos = {
  id: '0190f0c1-2222-7000-8000-000000000002',
  code: 'GS-1234',
  tenantId: '0190f0c1-1111-7000-8000-000000000001',
  branchId: '0190f0c1-3333-7000-8000-000000000003',
  startAt: new Date('2026-11-04T10:00:00.000Z'),
  status: 'checked_in',
  customerId: '0190f0c1-6666-7000-8000-000000000006',
  isGuest: false,
  items: [
    {
      id: '0190f0c1-7777-7000-8000-000000000007',
      serviceId: '0190f0c1-8888-7000-8000-000000000008',
      serviceName: 'Cut and finish',
      staffId: '0190f0c1-9999-7000-8000-000000000009',
      priceFils: 20000,
      durationMin: 45,
    },
  ],
  products: [
    {
      id: '0190f0c1-aaaa-7000-8000-00000000000a',
      productId: '0190f0c1-bbbb-7000-8000-00000000000b',
      productName: 'Argan oil 50ml',
      priceFils: 4500,
      quantity: 2,
    },
  ],
};
const EVENT = '0190f0c1-cccc-7000-8000-00000000000c';

describe('posSyncOf: which events reach the till', () => {
  it.each([
    ['booking.checked_in', { kind: 'open', bookingStatus: 'checked_in' }],
    ['session.started', { kind: 'status', bookingStatus: 'in_service' }],
    ['booking.completed', { kind: 'status', bookingStatus: 'completed' }],
    [
      'booking.check_in_undone',
      { kind: 'status', bookingStatus: 'check_in_undone' },
    ],
  ])('%s', (eventType, expected) => {
    expect(posSyncOf(eventType, {})).toEqual(expected);
  });

  it('voids on a cancel or no-show only after the customer arrived', () => {
    expect(posSyncOf('booking.cancelled', { from: 'checked_in' })).toEqual({
      kind: 'status',
      bookingStatus: 'cancelled',
    });
    expect(posSyncOf('booking.no_show', { from: 'in_service' })).toEqual({
      kind: 'status',
      bookingStatus: 'no_show',
    });
    expect(posSyncOf('booking.cancelled', { from: 'confirmed' })).toBeNull();
    expect(posSyncOf('booking.no_show', { from: 'confirmed' })).toBeNull();
    expect(posSyncOf('booking.cancelled', null)).toBeNull();
  });

  it.each([
    'booking.confirmed',
    'booking.shortened',
    'booking.settled',
    'reminder.24h',
    'walk_in.gap_available',
  ])('ignores %s', (eventType) => {
    expect(posSyncOf(eventType, { from: 'checked_in' })).toBeNull();
  });
});

describe('buildOpenRequest', () => {
  it('carries the booked prices, staff, products and deposit', () => {
    const r = buildOpenRequest({
      booking: BOOKING,
      contact: {
        email: 'maya@example.com',
        emailVerified: true,
        fullName: 'Maya K',
      },
      deposit: { balanceFils: 5000, vatFils: 238 },
      openedBy: '0190f0c1-dddd-7000-8000-00000000000d',
      eventId: EVENT,
    });
    expect(r).toEqual({
      tenant_id: BOOKING.tenantId,
      branch_id: BOOKING.branchId,
      booking_id: BOOKING.id,
      booking_code: 'GS-1234',
      start_at: '2026-11-04T10:00:00.000Z',
      opened_by_user_id: '0190f0c1-dddd-7000-8000-00000000000d',
      customer: {
        consumer_id: BOOKING.customerId,
        email: 'maya@example.com',
        full_name: 'Maya K',
      },
      items: [
        {
          booking_item_id: BOOKING.items[0]!.id,
          service_id: BOOKING.items[0]!.serviceId,
          service_name: 'Cut and finish',
          staff_profile_id: BOOKING.items[0]!.staffId,
          price_minor: 20000,
          duration_min: 45,
        },
      ],
      products: [
        {
          booking_product_id: BOOKING.products[0]!.id,
          variant_id: BOOKING.products[0]!.productId,
          name: 'Argan oil 50ml',
          qty: 2,
          price_minor: 4500,
        },
      ],
      deposit_available_minor: 5000,
      deposit_vat_minor: 238,
      idempotency_key: `booking:${BOOKING.id}:open:${EVENT}`,
    });
  });

  it('never sends an unverified address', () => {
    const r = buildOpenRequest({
      booking: BOOKING,
      contact: {
        email: 'typo@exmaple.com',
        emailVerified: false,
        fullName: 'M',
      },
      deposit: { balanceFils: 0, vatFils: 0 },
      openedBy: null,
      eventId: EVENT,
    });
    expect(r.customer).toEqual({
      consumer_id: BOOKING.customerId,
      email: '',
      full_name: 'M',
    });
    expect(r.opened_by_user_id).toBe('');
  });

  it('names no consumer for a guest lane of a party', () => {
    const r = buildOpenRequest({
      booking: { ...BOOKING, isGuest: true },
      contact: null,
      deposit: { balanceFils: 0, vatFils: 0 },
      openedBy: null,
      eventId: EVENT,
    });
    expect(r.customer).toEqual({ consumer_id: '', email: '', full_name: '' });
  });

  it('opens once per check-in: a second check-in after an undo is new', () => {
    const a = buildOpenRequest({
      booking: BOOKING,
      contact: null,
      deposit: { balanceFils: 0, vatFils: 0 },
      openedBy: null,
      eventId: EVENT,
    });
    const b = buildOpenRequest({
      booking: BOOKING,
      contact: null,
      deposit: { balanceFils: 0, vatFils: 0 },
      openedBy: null,
      eventId: '0190f0c1-eeee-7000-8000-00000000000e',
    });
    expect(a.idempotency_key).not.toBe(b.idempotency_key);
  });
});

describe('buildStatusRequest', () => {
  it('re-sends the deposit on COMPLETED', () => {
    expect(
      buildStatusRequest({
        booking: BOOKING,
        bookingStatus: 'completed',
        deposit: { balanceFils: 5000, vatFils: 238 },
        actorId: null,
        eventId: EVENT,
      }),
    ).toEqual({
      tenant_id: BOOKING.tenantId,
      booking_id: BOOKING.id,
      status: 'COMPLETED',
      deposit_available_minor: 5000,
      deposit_vat_minor: 238,
      actor_user_id: '',
      idempotency_key: `booking:${BOOKING.id}:${EVENT}`,
    });
  });

  it('sends no deposit with any other status', () => {
    const r = buildStatusRequest({
      booking: BOOKING,
      bookingStatus: 'check_in_undone',
      deposit: { balanceFils: 5000, vatFils: 238 },
      actorId: '0190f0c1-dddd-7000-8000-00000000000d',
      eventId: EVENT,
    });
    expect(r.status).toBe('CHECK_IN_UNDONE');
    expect(r.deposit_available_minor).toBe(0);
    expect(r.deposit_vat_minor).toBe(0);
    expect(r.actor_user_id).toBe('0190f0c1-dddd-7000-8000-00000000000d');
  });
});

describe('the small rules', () => {
  it('voids on undo, cancel and no-show, and nothing else', () => {
    expect(voidsTicket('check_in_undone')).toBe(true);
    expect(voidsTicket('cancelled')).toBe(true);
    expect(voidsTicket('no_show')).toBe(true);
    expect(voidsTicket('completed')).toBe(false);
    expect(voidsTicket('in_service')).toBe(false);
  });

  it('opens only for a visit still in progress', () => {
    expect(openStillWanted('checked_in')).toBe(true);
    expect(openStillWanted('completed')).toBe(true);
    expect(openStillWanted('confirmed')).toBe(false);
    expect(openStillWanted('cancelled')).toBe(false);
    expect(openStillWanted('settled')).toBe(false);
  });
});
