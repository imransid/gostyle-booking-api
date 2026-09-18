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
import {
  IdempotencyRepository,
  hashRequestBody,
} from '@infrastructure/persistence/idempotency.repository';
import { priceOf } from './confirm-booking.handler';
import { priceOfService } from '@domain/booking/service-resolution';
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
  /**
   * Idempotency-Key. A retried create must not make a SECOND series.
   *
   * Optional here rather than required, because the aggregate route has
   * existing callers that do not send one. When it is absent the handler
   * derives a key from the request itself, which closes the double-create
   * hole for them too -- the same trick confirm uses with `hold:<id>`.
   */
  readonly idempotencyKey?: string | undefined;
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
  /** True when this answer came from a stored response, not a new series. */
  readonly replayed?: boolean;
}

/** The operation name stored beside the key, for support. */
const SERIES_OPERATION = 'POST /v1/series';

@Injectable()
export class CreateSeriesHandler {
  constructor(
    private readonly repo: SeriesRepository,
    private readonly idempotency: IdempotencyRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    @Inject(CUSTOMER_CONTEXT) private readonly customers: CustomerContextReader,
  ) {}

  async execute(cmd: CreateSeriesCommand): Promise<SeriesView> {
    /**
     * THE REAL BUG THIS CLOSES. A retried create made a second series --
     * a standing weekly appointment duplicated for a year, with the customer
     * finding out before we did. `POST /v1/bookings` has replayed correctly
     * since it was written; this route never read the header at all.
     *
     * The fingerprint is everything that DEFINES the series. Two creates
     * with the same customer, service, anchor, time and pattern are the same
     * intent whether or not anyone sent a key.
     */
    const fingerprint = hashRequestBody({
      branchId: cmd.branchId,
      customerId: cmd.customerId,
      anchorDay: cmd.anchorDay,
      startMin: cmd.startMin,
      pattern: cmd.pattern,
      end: cmd.end,
      serviceId: cmd.serviceId,
      autoConfirmRule: cmd.autoConfirmRule,
    });
    const key = cmd.idempotencyKey ?? `series:${fingerprint}`;

    const replay = await this.idempotency.replay<SeriesView>(
      key,
      SERIES_OPERATION,
      fingerprint,
    );
    if (replay !== null) return replay;

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
      baselinePriceFils: priceOfService(service, priceOf),
      course: cmd.course,
      occurrences: expansion.occurrences,
      horizonEnd: expansion.horizonEnd,
    });

    const view: SeriesView = {
      seriesId: created.seriesId,
      planned: created.planned,
      horizonEnd: expansion.horizonEnd,
      explanation: expansion.explanation,
      firstOccurrences: expansion.occurrences
        .slice(0, 5)
        .map((o) => `${o.date} ${formatMinute(o.startMin)}`),
    };

    /**
     * REMEMBERED AFTER THE WRITE, not inside its transaction.
     *
     * The series row is what must not be duplicated, and it already exists by
     * the time this runs. If remembering fails the series is still correct --
     * a later retry simply gets a fresh one, which is the behaviour we have
     * today. Failing the whole create because the receipt could not be filed
     * would be strictly worse.
     */
    await this.idempotency.remember({
      key,
      operation: SERIES_OPERATION,
      requestHash: fingerprint,
      status: 201,
      body: view,
    });

    return view;
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
      // §15.2.1: "Every series panel shows the horizon line so the desk
      // knows exactly how far the calendar is real." It was hardcoded null,
      // so the panel showed no line at all — and the row has held the answer
      // since the series was created.
      horizonEnd: series.materialisedThrough,
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
   * Apply a pattern change at a scope.
   *
   * THE SCOPE IS THREE DIFFERENT PROMISES, and the planner already decides
   * which occurrences each one touches (`planEdit`). This only carries out
   * what the preview said, so what the desk was shown and what happens
   * cannot differ -- the same function answers both.
   *
   *   THIS_OCCURRENCE   detaches that visit; the pattern is UNCHANGED
   *   THIS_AND_FUTURE   re-expands from it forward; the past is untouched
   *   ENTIRE_SERIES     re-anchors the cadence; delivered visits stay
   */
  async applyPattern(input: {
    readonly seriesId: string;
    readonly occurrenceId: string;
    readonly scope: EditScope;
    readonly pattern?: Pattern | undefined;
    readonly startMin?: number | undefined;
    readonly reason: string;
  }): Promise<unknown> {
    // definition() rather than load(): it already returns the anchor, the
    // end condition and the pattern in the DOMAIN's shape, which is what
    // expandSeries takes. Rebuilding that here would be a second copy of the
    // row-to-domain mapping.
    const definition = await this.repo.definition(input.seriesId);
    if (definition === null) throw new NotFoundException('No such series');

    const timeline = await this.repo.timeline(input.seriesId);
    const plan = planEdit(
      input.scope,
      this.toDomain(timeline),
      input.occurrenceId,
    );

    // ---- THIS_OCCURRENCE: detach, do not re-pattern ----------------------
    if (input.scope === 'this_occurrence') {
      const detached = await this.repo.detachOccurrence(input.occurrenceId);
      return {
        seriesId: input.seriesId,
        scope: 'THIS_OCCURRENCE',
        detached: detached ? [input.occurrenceId] : [],
        patternChanged: false,
        cleared: 0,
        planned: 0,
        explanation:
          'That visit now stands on its own. The series keeps its cadence, ' +
          'and later edits skip this one.',
        occurrences: await this.occurrenceList(input.seriesId),
      };
    }

    if (input.pattern === undefined) {
      throw new UnprocessableEntityException(
        'A pattern is required for THIS_AND_FUTURE and ENTIRE_SERIES. ' +
          'Use THIS_OCCURRENCE to detach a single visit.',
      );
    }

    // ---- Re-expand from the right anchor ---------------------------------
    //
    // THIS_AND_FUTURE anchors on the occurrence the desk picked; the visits
    // before it keep the dates they were already given. ENTIRE_SERIES
    // re-anchors on the series' own anchor, which is what "the whole
    // cadence changes" means.
    const target = timeline.find((o) => o.id === input.occurrenceId);
    if (target === undefined) {
      throw new NotFoundException('No such occurrence in this series');
    }

    const anchor =
      input.scope === 'this_and_future' ? target.day : definition.anchor;
    const startMin = input.startMin ?? definition.startMin;

    const expansion = expandSeries(
      {
        anchor,
        startMin,
        pattern: input.pattern,
        // The end condition is not what is being edited here. A pattern
        // change that silently reset "after 12 visits" would be a different
        // and much larger promise than the desk made.
        end: definition.end,
      },
      { from: anchor, horizonDays: SERIES_HORIZON_DAYS },
    );

    if (expansion.occurrences.length === 0) {
      throw new UnprocessableEntityException(
        `That pattern produces no visits. ${expansion.explanation}`,
      );
    }

    const result = await this.repo.rewritePattern({
      seriesId: input.seriesId,
      // Only what the planner said is editable. A started or closed visit is
      // never in this list, so history survives by construction.
      clearOccurrenceIds: plan.affected,
      pattern: {
        kind: input.pattern.kind,
        weekdays: input.pattern.kind === 'weekly' ? input.pattern.weekdays : [],
        intervalWeeks:
          input.pattern.kind === 'every_n_weeks' ? input.pattern.weeks : null,
        dayOfMonth:
          input.pattern.kind === 'monthly_on_date'
            ? input.pattern.dayOfMonth
            : null,
        customDates: input.pattern.kind === 'custom' ? input.pattern.dates : [],
      },
      startMin: input.startMin ?? null,
      anchorDay: input.scope === 'entire_series' ? anchor : null,
      occurrences: expansion.occurrences,
      horizonEnd: expansion.horizonEnd,
      reason: input.reason,
    });

    return {
      seriesId: input.seriesId,
      scope: input.scope.toUpperCase(),
      patternChanged: true,
      cleared: result.cleared,
      planned: result.created,
      untouched: plan.untouched.length,
      ineligible: plan.ineligible.length,
      horizonEnd: expansion.horizonEnd,
      explanation: `${plan.explanation} ${expansion.explanation}`,
      // RETURNED IN THE SAME ROUND TRIP, so the timeline updates without a
      // second call -- the contract asks for this and the alternative is a
      // screen that briefly shows the old cadence.
      occurrences: await this.occurrenceList(input.seriesId),
    };
  }

  /** The timeline as the panel renders it. */
  private async occurrenceList(seriesId: string): Promise<OccurrenceView[]> {
    const timeline = await this.repo.timeline(seriesId);
    return timeline.map((o) => ({
      id: o.id,
      index: o.index,
      day: o.day,
      start: formatMinute(o.startMin),
      state: shout(o.state),
      bookingCode: o.bookingCode,
      bookingStatus: o.bookingStatus === null ? null : shout(o.bookingStatus),
      movedFromDayOfMonth: o.movedFromDayOfMonth,
      alternatives: o.alternatives,
    }));
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
