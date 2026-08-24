import type { Professional, Service } from '@domain/availability/feasible';
import type { StaffBooking } from '@domain/availability/staff-mask';
import type {
  ChairOccupation,
  ResourceType,
} from '@domain/availability/capacity';

/**
 * Everything the availability engine needs to know about one branch on one
 * day. Assembled by an adapter; the engine itself never fetches anything.
 */
export interface DayContext {
  readonly professionals: readonly Professional[];
  /** professional id -> what is already on their calendar */
  readonly staffBookings: ReadonlyMap<string, readonly StaffBooking[]>;
  readonly resources: readonly ResourceType[];
  readonly occupations: readonly ChairOccupation[];
  /** Set when the branch is shut. No offers are made and this is the reason. */
  readonly closureReason?: string;
}

/**
 * The ANTI-CORRUPTION LAYER.
 *
 * Catalogue, staff, shifts and chairs live in other services. This service
 * reaches them only through this interface, and only ever receives its own
 * domain types back. Three things fall out of that:
 *
 *   1. the engine can be tested against a fixture with zero network
 *   2. swapping the fixture for gRPC changes one provider, nothing else
 *   3. "closed by default" lives in the adapter: when an input cannot be
 *      verified, the adapter excludes that capacity rather than guessing
 */
export interface BookingContextReader {
  /** Snapshot the services being sold. Prices and durations as they are now. */
  loadServices(
    branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]>;

  /** The branch's people and places for one trading day. */
  loadDay(branchId: string, tradingDay: string): Promise<DayContext>;

  /** Everything on the menu. Used by the catalogue endpoint. */
  loadCatalogue(branchId: string): Promise<Service[]>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const BOOKING_CONTEXT = Symbol('BOOKING_CONTEXT');
