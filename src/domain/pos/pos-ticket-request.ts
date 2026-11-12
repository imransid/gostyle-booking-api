import type { DepositPosition } from '../journal/deposit-position';

/**
 * What booking-api tells the platform's POS about a visit
 * (proto/pos_booking.proto, PosBookingIntake).
 *
 * A booked customer checking in opens a ticket on the till carrying the
 * booked services at their BOOKED prices, the staff and the deposit already
 * paid; every later move of the visit is mirrored onto that ticket. This file
 * decides which events those are and builds each request from the booking
 * as it stands -- pure, so the mapping is tested without a platform.
 *
 * snake_case on purpose, like journal-entry-plan.ts: these are the wire
 * messages, sent as built.
 */

// ---------------------------------------------------------------- the events

/** The booking statuses a sync row carries (pos_ticket_sync_kind_matches). */
export type SyncBookingStatus =
  | 'checked_in'
  | 'in_service'
  | 'completed'
  | 'check_in_undone'
  | 'cancelled'
  | 'no_show';

export type PosSyncKind = 'open' | 'status';

export interface PosSyncIntent {
  readonly kind: PosSyncKind;
  readonly bookingStatus: SyncBookingStatus;
}

/** A cancel or no-show only touches the till if the customer had arrived. */
const ARRIVED: ReadonlySet<string> = new Set(['checked_in', 'in_service']);

/**
 * Which outbox events reach the till, and as what. Null: not the till's
 * business (a confirm, a reminder, a cancel before arrival, a shortened
 * visit -- whose price does not change).
 */
export function posSyncOf(
  eventType: string,
  payload: unknown,
): PosSyncIntent | null {
  switch (eventType) {
    case 'booking.checked_in':
      return { kind: 'open', bookingStatus: 'checked_in' };
    case 'session.started':
      return { kind: 'status', bookingStatus: 'in_service' };
    case 'booking.completed':
      return { kind: 'status', bookingStatus: 'completed' };
    case 'booking.check_in_undone':
      return { kind: 'status', bookingStatus: 'check_in_undone' };
    case 'booking.cancelled':
    case 'booking.no_show': {
      const from = (payload as { from?: unknown } | null)?.from;
      if (typeof from !== 'string' || !ARRIVED.has(from)) return null;
      return {
        kind: 'status',
        bookingStatus:
          eventType === 'booking.cancelled' ? 'cancelled' : 'no_show',
      };
    }
    default:
      return null;
  }
}

/** The proto's status names, for every sync status but the open. */
export type PosBookingStatus =
  'IN_SERVICE' | 'COMPLETED' | 'CHECK_IN_UNDONE' | 'CANCELLED' | 'NO_SHOW';

const POS_STATUS: Readonly<
  Record<Exclude<SyncBookingStatus, 'checked_in'>, PosBookingStatus>
> = {
  in_service: 'IN_SERVICE',
  completed: 'COMPLETED',
  check_in_undone: 'CHECK_IN_UNDONE',
  cancelled: 'CANCELLED',
  no_show: 'NO_SHOW',
};

export function posStatusOf(
  s: Exclude<SyncBookingStatus, 'checked_in'>,
): PosBookingStatus {
  return POS_STATUS[s];
}

/** The statuses that void the ticket on the till. */
export function voidsTicket(s: SyncBookingStatus): boolean {
  return s === 'check_in_undone' || s === 'cancelled' || s === 'no_show';
}

/**
 * The booking's status in which an open is the history this booking has
 * actually had. An open whose turn comes after the check-in was undone or
 * the visit cancelled would create a ticket only to void it a moment later:
 * it is skipped, and the void that follows finds no ticket and is done.
 */
export function openStillWanted(currentStatus: string): boolean {
  return (
    currentStatus === 'checked_in' ||
    currentStatus === 'in_service' ||
    currentStatus === 'completed'
  );
}

/** What the sync row's booking status means in booking_status_history. */
export function historyStatusOf(s: SyncBookingStatus): string {
  return s === 'check_in_undone' ? 'confirmed' : s;
}

// ---------------------------------------------------------------- the keys

/** Per event: an undo and a second check-in is a second, different open. */
export function openKey(bookingId: string, eventId: string): string {
  return `booking:${bookingId}:open:${eventId}`;
}

export function statusKey(bookingId: string, eventId: string): string {
  return `booking:${bookingId}:${eventId}`;
}

// ---------------------------------------------------------------- the wire

export interface PosCustomerWire {
  readonly consumer_id: string;
  readonly email: string;
  readonly full_name: string;
}

export interface BookedServiceWire {
  readonly booking_item_id: string;
  readonly service_id: string;
  readonly service_name: string;
  readonly staff_profile_id: string;
  readonly price_minor: number;
  readonly duration_min: number;
}

export interface BookedProductWire {
  readonly booking_product_id: string;
  readonly variant_id: string;
  readonly name: string;
  readonly qty: number;
  readonly price_minor: number;
}

export interface OpenTicketForBookingRequest {
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly booking_id: string;
  readonly booking_code: string;
  readonly start_at: string;
  readonly opened_by_user_id: string;
  readonly customer: PosCustomerWire;
  readonly items: readonly BookedServiceWire[];
  readonly products: readonly BookedProductWire[];
  readonly deposit_available_minor: number;
  readonly deposit_vat_minor: number;
  readonly idempotency_key: string;
}

export interface UpdateBookingStatusRequest {
  readonly tenant_id: string;
  readonly booking_id: string;
  readonly status: PosBookingStatus;
  readonly deposit_available_minor: number;
  readonly deposit_vat_minor: number;
  readonly actor_user_id: string;
  readonly idempotency_key: string;
}

// ---------------------------------------------------------------- the booking

/** The booking as the till needs it, read at send time. */
export interface BookingForPos {
  readonly id: string;
  readonly code: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly startAt: Date;
  readonly status: string;
  readonly customerId: string;
  /**
   * A guest lane of a party: its customer id is the group's, not a person's
   * (group-confirm.repository.ts), so no consumer is named.
   */
  readonly isGuest: boolean;
  readonly items: readonly {
    readonly id: string;
    readonly serviceId: string;
    readonly serviceName: string;
    readonly staffId: string;
    readonly priceFils: number;
    readonly durationMin: number;
  }[];
  readonly products: readonly {
    readonly id: string;
    readonly productId: string;
    readonly productName: string;
    readonly priceFils: number;
    readonly quantity: number;
  }[];
}

/** customer-api's answer, or nothing when it had none. */
export interface PosContact {
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly fullName: string | null;
}

export function buildOpenRequest(input: {
  readonly booking: BookingForPos;
  readonly contact: PosContact | null;
  readonly deposit: DepositPosition;
  /** Who checked them in: the approver of a self check-in. Null: unknown. */
  readonly openedBy: string | null;
  readonly eventId: string;
}): OpenTicketForBookingRequest {
  const { booking: b, contact } = input;
  return {
    tenant_id: b.tenantId,
    branch_id: b.branchId,
    booking_id: b.id,
    booking_code: b.code,
    start_at: b.startAt.toISOString(),
    opened_by_user_id: input.openedBy ?? '',
    customer: b.isGuest
      ? { consumer_id: '', email: '', full_name: '' }
      : {
          consumer_id: b.customerId,
          // Only a verified address: the till matches a CRM customer on it,
          // and a typo would hand this visit to somebody else's record.
          email:
            contact !== null && contact.emailVerified
              ? (contact.email ?? '')
              : '',
          full_name: contact?.fullName ?? '',
        },
    items: b.items.map((i) => ({
      booking_item_id: i.id,
      service_id: i.serviceId,
      service_name: i.serviceName,
      staff_profile_id: i.staffId,
      // The BOOKED price, frozen when it was booked: a package part already
      // carries its share of the package price (domain/booking/package.ts).
      price_minor: i.priceFils,
      duration_min: i.durationMin,
    })),
    products: b.products.map((p) => ({
      booking_product_id: p.id,
      variant_id: p.productId,
      name: p.productName,
      qty: p.quantity,
      price_minor: p.priceFils,
    })),
    deposit_available_minor: input.deposit.balanceFils,
    deposit_vat_minor: input.deposit.vatFils,
    idempotency_key: openKey(b.id, input.eventId),
  };
}

export function buildStatusRequest(input: {
  readonly booking: Pick<BookingForPos, 'id' | 'tenantId'>;
  readonly bookingStatus: Exclude<SyncBookingStatus, 'checked_in'>;
  readonly deposit: DepositPosition;
  readonly actorId: string | null;
  readonly eventId: string;
}): UpdateBookingStatusRequest {
  const completed = input.bookingStatus === 'completed';
  return {
    tenant_id: input.booking.tenantId,
    booking_id: input.booking.id,
    status: posStatusOf(input.bookingStatus),
    // COMPLETED only, says the proto: the deposit as it stands when the
    // ticket moves to the checkout queue.
    deposit_available_minor: completed ? input.deposit.balanceFils : 0,
    deposit_vat_minor: completed ? input.deposit.vatFils : 0,
    actor_user_id: input.actorId ?? '',
    idempotency_key: statusKey(input.booking.id, input.eventId),
  };
}
