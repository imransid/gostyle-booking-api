import { shout, type Shouted } from '@application/contract/wire';
import type { OccurrenceState } from '../../generated/prisma/enums';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { SeriesRepository } from '@infrastructure/persistence/series.repository';
import {
  expandSeries,
  SERIES_HORIZON_DAYS,
  type EndCondition,
  type Pattern,
  type SeriesDefinition,
} from '@domain/booking/recurrence';
import {
  deriveSeriesHealth,
  type SeriesHealth,
  type RiskReason,
  type SeriesStatus,
} from '@domain/booking/series-health';
import {
  planEdit,
  planPauseOrEnd,
  type EditScope,
  type SeriesOccurrence,
} from '@domain/booking/series-edit';
import { mayHoldStandingReservation } from '@domain/booking/auto-confirm';
import { courseState, planDraws } from '@domain/booking/course';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import { formatMinute } from '@domain/availability/grid';
import { priceOf } from './confirm-booking.handler';
import type { BookingStatus } from '@domain/booking/lifecycle';

export interface CreateSeriesCommand {
  readonly branchId: string;
  readonly customerId: string;
  readonly anchorDay: string;
  readonly startMin: number;
  readonly pattern: Pattern;
  readonly end: EndCondition;
  readonly autoConfirmRule:
    'auto_confirm_on_schedule' | 'ask_each_time' | 'vip_standing';
  readonly serviceId: string;
  readonly preferredStaffId: string | null;
  readonly course: {
    readonly totalNetFils: number;
    readonly visits: number;
  } | null;
}

export interface SeriesView {
  readonly seriesId: string;
  readonly planned: number;
  readonly horizonEnd: string;
  readonly explanation: string;
  readonly firstOccurrences: readonly string[];
}

@Injectable()
export class CreateSeriesHandler {
  constructor(
    private readonly repo: SeriesRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    @Inject(CUSTOMER_CONTEXT) private readonly customers: CustomerContextReader,
  ) {}

  async execute(cmd: CreateSeriesCommand): Promise<SeriesView> {
    const services = await this.context.loadServices(cmd.branchId, [
      cmd.serviceId,
    ]);
    if (services.length === 0) {
      throw new NotFoundException(`Unknown service: ${cmd.serviceId}`);
    }
    const service = services[0]!;

    // A standing reservation is a tier privilege. Refusing it at creation is
    // kinder than accepting it and quietly downgrading every occurrence to
    // "ask the customer" at materialisation, which is what the rule table
    // does when the tier does not qualify.
    if (cmd.autoConfirmRule === 'vip_standing') {
      const customer = await this.customers.load(cmd.customerId);
      if (!mayHoldStandingReservation(customer.tier)) {
        throw new UnprocessableEntityException(
          `A standing reservation needs Gold or Royal. This customer is ${customer.tier}.`,
        );
      }
    }

    const definition: SeriesDefinition = {
      anchor: cmd.anchorDay,
      startMin: cmd.startMin,
      pattern: cmd.pattern,
      end: cmd.end,
    };

    const expansion = expandSeries(definition, {
      from: cmd.anchorDay,
      horizonDays: SERIES_HORIZON_DAYS,
    });

    if (expansion.occurrences.length === 0) {
      throw new UnprocessableEntityException(
        `That pattern produces no visits. ${expansion.explanation}`,
      );
    }

    const created = await this.repo.create({
      branchId: cmd.branchId,
      customerId: cmd.customerId,
      anchorDay: cmd.anchorDay,
      startMin: cmd.startMin,
      pattern: cmd.pattern.kind,
      weekdays: cmd.pattern.kind === 'weekly' ? cmd.pattern.weekdays : [],
      intervalWeeks:
        cmd.pattern.kind === 'every_n_weeks' ? cmd.pattern.weeks : null,
      dayOfMonth:
        cmd.pattern.kind === 'monthly_on_date' ? cmd.pattern.dayOfMonth : null,
      customDates: cmd.pattern.kind === 'custom' ? cmd.pattern.dates : [],
      endKind: cmd.end.kind,
      endDate: cmd.end.kind === 'on_date' ? cmd.end.date : null,
      endCount: cmd.end.kind === 'after_count' ? cmd.end.count : null,
      autoConfirmRule: cmd.autoConfirmRule,
      serviceId: cmd.serviceId,
      preferredStaffId: cmd.preferredStaffId,
      // The SAME price source the confirm path uses. A series that priced
      // itself would drift from the catalogue the moment either moved.
      baselinePriceFils: priceOf(service.id),
      course: cmd.course,
      occurrences: expansion.occurrences,
      horizonEnd: expansion.horizonEnd,
    });

    return {
      seriesId: created.seriesId,
      planned: created.planned,
      horizonEnd: expansion.horizonEnd,
      explanation: expansion.explanation,
      firstOccurrences: expansion.occurrences
        .slice(0, 5)
        .map((o) => `${o.date} ${formatMinute(o.startMin)}`),
    };
  }
}

export interface OccurrenceView {
  readonly id: string;
  readonly index: number;
  readonly day: string;
  readonly start: string;
  readonly state: Shouted<OccurrenceState>;
  readonly bookingCode: string | null;
  readonly bookingStatus: Shouted<BookingStatus> | null;
  readonly movedFromDayOfMonth: number | null;
  readonly alternatives: unknown;
}

export interface SeriesPanelView {
  readonly seriesId: string;
  readonly status: Shouted<SeriesStatus>;
  readonly health: Shouted<SeriesHealth>;
  readonly healthReasons: readonly Shouted<RiskReason>[];
  readonly healthExplanation: string;
  readonly horizonEnd: string | null;
  readonly occurrences: readonly OccurrenceView[];
  readonly course: {
    readonly visits: number;
    readonly drawn: number;
    readonly remainingMinor: number;
    readonly remaining: string;
    readonly perVisitMinor: number;
    readonly explanation: string;
  } | null;
}

@Injectable()
export class SeriesPanelHandler {
  constructor(private readonly repo: SeriesRepository) {}

  async execute(seriesId: string): Promise<SeriesPanelView> {
    const series = await this.repo.load(seriesId);
    if (series === null) throw new NotFoundException('No such series');

    const [timeline, facts] = await Promise.all([
      this.repo.timeline(seriesId),
      this.repo.healthFacts(seriesId),
    ]);

    const health = deriveSeriesHealth({
      status: series.status,
      ...facts,
    });

    const course =
      series.courseVisits === null || series.courseTotalNetFils === null
        ? null
        : (() => {
            const def = {
              totalNetFils: series.courseTotalNetFils,
              visits: series.courseVisits,
            };
            const state = courseState(def, series.courseDrawn);
            const draws = planDraws(def);
            return {
              visits: state.visits,
              drawn: state.drawnCount,
              remainingMinor: state.remainingGrossFils,
              remaining: `AED ${(state.remainingGrossFils / 100).toFixed(2)}`,
              perVisitMinor: draws[0]?.grossFils ?? 0,
              explanation: state.explanation,
            };
          })();

    return {
      seriesId,
      status: shout(series.status),
      health: shout(health.health),
      healthReasons: health.reasons.map(shout),
      healthExplanation: health.explanation,
      horizonEnd: null,
      occurrences: timeline.map((o) => ({
        id: o.id,
        index: o.index,
        day: o.day,
        start: formatMinute(o.startMin),
        state: shout(o.state),
        bookingCode: o.bookingCode,
        bookingStatus: o.bookingStatus === null ? null : shout(o.bookingStatus),
        movedFromDayOfMonth: o.movedFromDayOfMonth,
        alternatives: o.alternatives,
      })),
      course,
    };
  }
}

export interface LifecycleResult {
  readonly seriesId: string;
  readonly status: Shouted<SeriesStatus>;
  readonly cancelled: number;
  readonly needsExplicitConfirmation: readonly string[];
  readonly explanation: string;
}

@Injectable()
export class SeriesLifecycleHandler {
  constructor(private readonly repo: SeriesRepository) {}

  /**
   * Pause or end. Both plan identically; they differ only in what the
   * definition becomes afterwards.
   */
  async pauseOrEnd(
    seriesId: string,
    to: 'paused' | 'ended',
  ): Promise<LifecycleResult> {
    const series = await this.repo.load(seriesId);
    if (series === null) throw new NotFoundException('No such series');

    const timeline = await this.repo.timeline(seriesId);
    const plan = planPauseOrEnd(this.toDomain(timeline));

    const cancelled = await this.repo.cancelOccurrences(
      plan.cancel,
      to === 'paused' ? 'series paused' : 'series ended',
    );
    await this.repo.setStatus(seriesId, to);

    return {
      seriesId,
      status: shout(to),
      cancelled,
      needsExplicitConfirmation: plan.needsExplicitConfirmation,
      explanation: plan.explanation,
    };
  }

  async resume(seriesId: string): Promise<LifecycleResult> {
    const series = await this.repo.load(seriesId);
    if (series === null) throw new NotFoundException('No such series');
    if (series.status === 'ended' || series.status === 'completed') {
      throw new UnprocessableEntityException(
        `A ${series.status} series cannot be resumed. Create a new one.`,
      );
    }
    await this.repo.setStatus(seriesId, 'active');
    return {
      seriesId,
      status: shout('active'),
      cancelled: 0,
      needsExplicitConfirmation: [],
      explanation:
        'The series is active again. The next materialiser run refills the horizon.',
    };
  }

  /** Skip one occurrence. The series continues. */
  async skip(seriesId: string, occurrenceId: string): Promise<LifecycleResult> {
    const timeline = await this.repo.timeline(seriesId);
    const target = timeline.find((o) => o.id === occurrenceId);
    if (target === undefined) {
      throw new NotFoundException('That occurrence is not part of this series');
    }
    const cancelled = await this.repo.cancelOccurrences(
      [occurrenceId],
      'occurrence skipped',
    );
    return {
      seriesId,
      status: shout('active'),
      cancelled,
      needsExplicitConfirmation: [],
      explanation:
        'Occurrence skipped. The slot is released and the series continues.',
    };
  }

  /** Which occurrences would an edit at this scope touch? */
  async previewEdit(
    seriesId: string,
    occurrenceId: string,
    scope: EditScope,
  ): Promise<{
    readonly affected: readonly string[];
    readonly detached: readonly string[];
    readonly untouched: readonly string[];
    readonly ineligible: readonly string[];
    readonly explanation: string;
  }> {
    const timeline = await this.repo.timeline(seriesId);
    const plan = planEdit(scope, this.toDomain(timeline), occurrenceId);
    return {
      affected: plan.affected,
      detached: plan.detached,
      untouched: plan.untouched,
      ineligible: plan.ineligible,
      explanation: plan.explanation,
    };
  }

  /**
   * The stored timeline as the domain's occurrence shape.
   *
   * startsInHours is computed by the repository against the booking's real
   * instant, because turning a trading day into one needs the branch offset
   * and the domain does not reach into persistence for it.
   */
  private toDomain(
    timeline: Awaited<ReturnType<SeriesRepository['timeline']>>,
  ): SeriesOccurrence[] {
    return timeline.map((o) => ({
      id: o.id,
      date: o.day,
      startMin: o.startMin,
      // THE OCCURRENCE STATE OUTRANKS THE BOOKING STATUS, because a skipped
      // or detached occurrence has no booking at all and would otherwise map
      // to 'draft' -- which is open, which means a later pause cancels it a
      // second time and reports it as though it were a live visit.
      status: statusOfOccurrence(o.state, o.bookingStatus),
      startsInHours: o.startsInHours,
    }));
  }
}

/**
 * One occurrence's effective status.
 *
 * A materialised occurrence is whatever its booking says. Everything else is
 * described by the occurrence row itself: there is no booking to ask.
 */
function statusOfOccurrence(
  state: OccurrenceState,
  bookingStatus: BookingStatus | null,
): BookingStatus {
  if (state === 'skipped') return 'skipped';
  if (state === 'detached') return 'cancelled';
  if (bookingStatus !== null) return bookingStatus;
  return 'draft';
}
