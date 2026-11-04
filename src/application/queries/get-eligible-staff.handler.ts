import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { eligible } from '@domain/availability/feasible';
import { DAILY_BOOKING_CAP } from '@domain/availability/grid';
import { describeRefusal } from './get-availability.handler';
import { resolveBasket } from '@application/commands/basket';
import { PlatformPackageCatalogue } from '@infrastructure/persistence/platform-package-catalogue';

export interface EligibleStaffQuery {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly serviceIds: readonly string[];
  readonly preferredStaffId: string | null;
}

export interface EligibleStaffView {
  readonly branchId: string;
  readonly tradingDay: string;
  /** After any package expanded, in chain order: who does the parts. */
  readonly serviceIds: readonly string[];
  /** The skills this chain needs, in the order the services were given. */
  readonly requiredSkills: readonly string[];
  readonly durationMin: number;
  readonly eligible: readonly {
    readonly id: string;
    readonly name: string;
    readonly bookingsToday: number;
  }[];
  /** Named, with the reason, because an unexplained empty list is a ticket. */
  readonly refused: readonly {
    readonly id: string;
    readonly name: string;
    readonly reason: string;
  }[];
  readonly closureReason?: string;
}

/**
 * Who may take this chain, before anyone asks when.
 *
 * The wizard needs this at stage 2 — after the services are picked and before
 * a time exists — to answer "who can do this?" and to explain a preference it
 * cannot honour. The availability endpoint answers the same question as a side
 * effect, but only once a whole day of masks has been computed; this is the
 * cheap version, and it runs THE SAME eligible() the engine runs, so the two
 * can never disagree about who is certified (CLAUDE.md 4).
 */
@Injectable()
export class GetEligibleStaffHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly packageCatalogue: PlatformPackageCatalogue,
  ) {}

  async execute(query: EligibleStaffQuery): Promise<EligibleStaffView> {
    // The same basket every other stage of the wizard resolves, so a
    // package picked at stage 1 is not "Unknown service" here at stage 2:
    // who may do it is who may do every one of its parts.
    const basket = await resolveBasket(
      this.context,
      this.packageCatalogue,
      query.branchId,
      query.serviceIds,
    );
    if (basket.missing.length > 0) {
      throw new NotFoundException(
        `Unknown service: ${basket.missing.join(', ')}`,
      );
    }
    const services = basket.services;

    const day = await this.context.loadDay(query.branchId, query.tradingDay);

    const base = {
      branchId: query.branchId,
      tradingDay: query.tradingDay,
      serviceIds: basket.serviceIds,
      requiredSkills: services.map((s) => s.skill),
      durationMin: services.reduce((n, s) => n + s.durationMin, 0),
    };

    // A closed day has no eligible anybody, and says why.
    if (day.closureReason !== undefined) {
      return {
        ...base,
        eligible: [],
        refused: [],
        closureReason: day.closureReason,
      };
    }

    const result = eligible(
      day.professionals,
      services,
      query.preferredStaffId,
      DAILY_BOOKING_CAP,
    );

    const nameOf = (id: string): string =>
      day.professionals.find((p) => p.id === id)?.name ?? id;
    const loadOf = (id: string): number =>
      day.professionals.find((p) => p.id === id)?.bookingsToday ?? 0;

    return {
      ...base,
      eligible: result.pool.map((id) => ({
        id,
        name: nameOf(id),
        bookingsToday: loadOf(id),
      })),
      refused: [...result.excluded].map(([id, reason]) => ({
        id,
        name: nameOf(id),
        reason: describeRefusal(reason),
      })),
    };
  }
}
