import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import { SeriesRepository } from '@infrastructure/persistence/series.repository';
import {
  feasibleSet,
  staffAvailableAt,
  DESK_CHANNEL,
  WHOLE_DAY,
} from '@domain/availability/feasible';
import { toSlots } from '@domain/availability/mask';
import { toMin, DAILY_BOOKING_CAP } from '@domain/availability/grid';
import {
  repairOccurrence,
  type RepairCandidate,
} from '@domain/availability/series-ladder';
import {
  expandSeries,
  daysBetween,
  BOOKING_HORIZON_DAYS,
  SERIES_HORIZON_DAYS,
  type SeriesDefinition,
} from '@domain/booking/recurrence';
import { birthState } from '@domain/booking/auto-confirm';
import { requirementFor, DEFAULT_BRANCH } from '@domain/booking/customer';
import { priceOf } from './confirm-booking.handler';

/**
 * How many times one occurrence may be refused at the write before it is
 * handed to a human. Three because each refusal eliminates one professional,
 * and a day where three separate people are all secretly busy elsewhere is
 * not a race any more, it is a roster problem.
 */
const MAX_WRITE_ATTEMPTS = 3;

export interface MaterialiseResult {
  readonly seriesId: string;
  readonly considered: number;
  readonly materialised: number;
  readonly repaired: number;
  readonly needsAttention: number;
  readonly deferred: number;
  readonly raced: number;
  readonly notes: readonly string[];
}

/**
 * Turn planned occurrences into real bookings.
 *
 * MATERIALISATION RUNS THE SAME ENGINE A MANUAL BOOKING RUNS. Not a cheaper
 * approximation of it: a standing client's Tuesday has to respect the same
 * shifts, buffers, chair counts and daily caps as a walk-up, or the diary
 * quietly fills with visits nobody can deliver.
 *
 * The handler owns the ports and hands the repository a decided slot, per the
 * layering rule. Persistence never asks the world a question.
 */
@Injectable()
export class MaterialiseSeriesHandler {
  private static readonly log = new Logger(MaterialiseSeriesHandler.name);

  constructor(
    private readonly repo: SeriesRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    @Inject(CUSTOMER_CONTEXT) private readonly customers: CustomerContextReader,
  ) {}

  /** Top the calendar up to the horizon, then seat everything inside it. */
  async run(seriesId: string, today: string): Promise<MaterialiseResult> {
    const series = await this.repo.load(seriesId);
    if (series === null) {
      return this.empty(seriesId, ['No such series.']);
    }
    if (series.status !== 'active') {
      return this.empty(seriesId, [
        `Series is ${series.status}; nothing materialised.`,
      ]);
    }

    const definition = await this.definitionOf(seriesId);
    if (definition !== null) {
      const expansion = expandSeries(definition, {
        from: today,
        horizonDays: SERIES_HORIZON_DAYS,
      });
      await this.repo.topUp(
        seriesId,
        expansion.occurrences,
        expansion.horizonEnd,
      );
    }

    // Only inside the BOOKING horizon. Beyond it the diary is not real yet,
    // and a slot chosen now is a guess the nightly run would make again.
    const bookable = this.addDays(today, BOOKING_HORIZON_DAYS);
    const planned = await this.repo.plannedWithin(seriesId, bookable);

    const notes: string[] = [];
    let materialised = 0;
    let repaired = 0;
    let needsAttention = 0;
    let deferred = 0;
    let raced = 0;

    for (const occ of planned) {
      const outcome = await this.seat(series, occ, today);
      switch (outcome) {
        case 'materialised':
          materialised += 1;
          break;
        case 'repaired':
          materialised += 1;
          repaired += 1;
          break;
        case 'needs_attention':
          needsAttention += 1;
          break;
        case 'deferred':
          deferred += 1;
          break;
        case 'raced':
          raced += 1;
          break;
      }
    }

    if (raced > 0) {
      notes.push(
        `${raced} lost the slot at the write and stay planned for the next run.`,
      );
    }
    if (needsAttention > 0) {
      notes.push(`${needsAttention} could not be seated and need a human.`);
    }

    return {
      seriesId,
      considered: planned.length,
      materialised,
      repaired,
      needsAttention,
      deferred,
      raced,
      notes,
    };
  }

  /**
   * THE READ HALF of seating an occurrence: what could take it, and where.
   *
   * Shared with the preview endpoint, which needs exactly this and must not
   * write. Two copies of "which starts are open for a series occurrence"
   * would drift, and the drift would show up as a preview promising a date
   * the nightly materialiser then refuses -- the one thing a preview exists
   * to prevent.
   */
  async candidatesFor(
    series: NonNullable<Awaited<ReturnType<SeriesRepository['load']>>>,
    occ: { plannedDay: string; plannedStartMin: number },
    today: string,
  ): Promise<
    | { kind: 'no_service' }
    | { kind: 'closed'; reason: string }
    | {
        kind: 'ok';
        service: {
          id: string;
          name: string;
          resourceType: string;
          skill: string;
          depositPercent?: number | null;
          depositFixedFils?: number | null;
        };
        result: {
          durationMin: number;
          claims: { preMin: number; postMin: number };
        };
        candidates: readonly RepairCandidate[];
      }
  > {
    const services = await this.context.loadServices(series.branchId, [
      series.serviceId,
    ]);
    const service = services[0];
    if (service === undefined) return { kind: 'no_service' };

    const day = await this.context.loadDay(series.branchId, occ.plannedDay);
    if (day.closureReason !== undefined) {
      // A closed day has no alternatives to offer, and saying so is more
      // use to the desk than an empty list that looks like a search failure.
      return { kind: 'closed', reason: day.closureReason };
    }

    const result = feasibleSet({
      services,
      professionals: day.professionals,
      staffBookings: day.staffBookings,
      resources: day.resources,
      occupations: day.occupations,
      channel: DESK_CHANNEL,
      window: WHOLE_DAY,
      // The engine is asked about the WHOLE day, not just the wanted minute.
      // Rungs three and four need the rest of the day to choose from, and
      // asking twice would be two answers that can disagree.
      preferredStaffId: null,
      isToday: occ.plannedDay === today,
      nowMin: 0,
      dailyCap: DAILY_BOOKING_CAP,
    });

    const candidates: RepairCandidate[] = [];
    for (const slot of toSlots(result.union)) {
      const startMin = toMin(slot);
      for (const staffId of staffAvailableAt(result, slot)) {
        candidates.push({ startMin, staffId, durationMin: result.durationMin });
      }
    }

    return { kind: 'ok', service, result, candidates };
  }

  private async seat(
    series: NonNullable<Awaited<ReturnType<SeriesRepository['load']>>>,
    occ: {
      id: string;
      index: number;
      plannedDay: string;
      plannedStartMin: number;
    },
    today: string,
  ): Promise<
    'materialised' | 'repaired' | 'needs_attention' | 'deferred' | 'raced'
  > {
    const daysAhead = daysBetween(today, occ.plannedDay);
    if (daysAhead > BOOKING_HORIZON_DAYS) return 'deferred';

    const read = await this.candidatesFor(series, occ, today);
    if (read.kind === 'no_service' || read.kind === 'closed') {
      await this.repo.markNeedsAttention(occ.id, []);
      return 'needs_attention';
    }
    const { service, result, candidates } = read;

    // A LOST RACE MUST CONVERGE.
    //
    // The exclusion constraint is global on (staff, time); the availability
    // query is scoped to one branch. A professional booked at another branch
    // is therefore offered here and refused at the write, every single run.
    // Leaving the occurrence planned would retry it nightly forever and never
    // tell anybody. So a refusal drops that candidate and the ladder runs
    // again on what is left, which either seats it or says it needs a human.
    const rejected = new Set<string>();
    const keyOf = (startMin: number, staffId: string): string =>
      `${startMin}:${staffId}`;

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const usable = candidates.filter(
        (c) => !rejected.has(keyOf(c.startMin, c.staffId)),
      );
      const seated = await this.attempt(
        series,
        occ,
        usable,
        daysAhead,
        service,
        result,
      );
      if (seated.kind !== 'raced') return seated.outcome;
      rejected.add(keyOf(seated.startMin, seated.staffId));
    }

    // Every attempt was refused at the write. That is not a slot problem the
    // ladder can solve, so a human sees it.
    await this.repo.markNeedsAttention(occ.id, []);
    return 'needs_attention';
  }

  /** One pass of the ladder, followed by one write. */
  private async attempt(
    series: NonNullable<Awaited<ReturnType<SeriesRepository['load']>>>,
    occ: {
      id: string;
      index: number;
      plannedDay: string;
      plannedStartMin: number;
    },
    candidates: readonly RepairCandidate[],
    daysAhead: number,
    service: {
      id: string;
      name: string;
      resourceType: string;
      skill: string;
      depositPercent?: number | null;
      depositFixedFils?: number | null;
    },
    result: {
      durationMin: number;
      claims: { preMin: number; postMin: number };
    },
  ): Promise<
    | {
        kind: 'done';
        outcome: 'materialised' | 'repaired' | 'needs_attention' | 'deferred';
      }
    | { kind: 'raced'; startMin: number; staffId: string }
  > {
    const decision = repairOccurrence({
      originalStartMin: occ.plannedStartMin,
      // A series with no preferred professional can never match rung one,
      // so it falls straight to "the same time with anyone", which is
      // exactly right: there is no incumbent to keep.
      incumbentStaffId: series.preferredStaffId ?? '',
      candidates,
      daysAhead,
      bookingHorizonDays: BOOKING_HORIZON_DAYS,
    });

    if (decision.kind === 'deferred')
      return { kind: 'done', outcome: 'deferred' };
    if (decision.kind === 'needs_attention') {
      await this.repo.markNeedsAttention(occ.id, decision.alternatives);
      return { kind: 'done', outcome: 'needs_attention' };
    }

    // The requirement is resolved PER OCCURRENCE, never once for the series:
    // a client's risk band and the branch's peak hours both move underneath a
    // standing booking.
    const customer = await this.customers.load(series.customerId);
    const priceFils = series.grandfathered
      ? series.baselinePriceFils
      : priceOf(service.id);

    const requirement = requirementFor({
      totalFils: priceFils,
      risk: customer.risk,
      riskScore: customer.riskScore,
      requireDepositFlag: customer.requireDepositFlag,
      service: {
        name: service.name,
        percent: service.depositPercent ?? null,
        fixedFils: service.depositFixedFils ?? null,
      },
      isNewCustomer: customer.isNewCustomer,
      channel: 'online',
      startMin: decision.offer.startMin,
      branch: DEFAULT_BRANCH,
    });

    const birth = birthState({
      rule: series.autoConfirmRule,
      requirement: requirement.kind,
      tier: customer.tier,
    });

    const written = await this.repo.materialise({
      occurrenceId: occ.id,
      branchId: series.branchId,
      customerId: series.customerId,
      tradingDay: occ.plannedDay,
      startMin: decision.offer.startMin,
      durationMin: result.durationMin,
      staffId: decision.offer.staffId,
      serviceId: service.id,
      serviceName: service.name,
      resourceType: service.resourceType,
      requiredSkill: service.skill,
      priceFils,
      // Nothing is banked here. Materialisation creates the booking; money
      // arrives later on the payment link, or never at all where the rule
      // waived it. A deposit written now would be money nobody has paid.
      depositFils: 0,
      status: birth.status,
      paymentStatus:
        birth.status === 'pending_payment' ? 'unpaid' : 'none_required',
      claimPreMin: result.claims.preMin,
      claimPostMin: result.claims.postMin,
    });

    if (written.kind === 'raced') {
      return {
        kind: 'raced',
        startMin: decision.offer.startMin,
        staffId: decision.offer.staffId,
      };
    }

    MaterialiseSeriesHandler.log.log(
      `Occurrence ${occ.index} of series ${series.id} -> ${written.code} ` +
        `at ${decision.offer.startMin} with ${decision.offer.staffId} (${decision.rung})`,
    );

    // Rung one is the occurrence the series actually asked for. Every other
    // rung moved something, and the panel should say so.
    return {
      kind: 'done',
      outcome:
        decision.rung === 'same_time_same_professional'
          ? 'materialised'
          : 'repaired',
    };
  }

  /** Rebuild the domain definition from the stored row. */
  private async definitionOf(
    seriesId: string,
  ): Promise<SeriesDefinition | null> {
    return this.repo.definition(seriesId);
  }

  private addDays(day: string, n: number): string {
    const [y, m, d] = day.split('-').map(Number);
    const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + n * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  private empty(seriesId: string, notes: string[]): MaterialiseResult {
    return {
      seriesId,
      considered: 0,
      materialised: 0,
      repaired: 0,
      needsAttention: 0,
      deferred: 0,
      raced: 0,
      notes,
    };
  }
}
