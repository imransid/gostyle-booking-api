import { Injectable } from '@nestjs/common';
import { MaterialiseSeriesHandler } from '@application/commands/materialise-series.handler';
import {
  expandSeries,
  daysBetween,
  BOOKING_HORIZON_DAYS,
  SERIES_HORIZON_DAYS,
  type EndCondition,
  type Pattern,
} from '@domain/booking/recurrence';
import { repairOccurrence } from '@domain/availability/series-ladder';
import { formatMinute } from '@domain/availability/grid';
import { shout, type Shouted } from '@application/contract/wire';

export interface SeriesPreviewQuery {
  readonly branchId: string;
  readonly customerId: string;
  readonly serviceId: string;
  readonly preferredStaffId: string | null;
  readonly anchorDay: string;
  readonly startMin: number;
  readonly pattern: Pattern;
  readonly end: EndCondition;
  /** Defaults to the branch's today. */
  readonly from: string;
  readonly horizonDays?: number;
}

type Verdict =
  /** The wanted minute, with the wanted person. */
  | 'EXACT'
  /** Seatable, but the ladder had to move it. */
  | 'REPAIRABLE'
  /** Nothing the ladder can do. Alternatives attached if any exist. */
  | 'NEEDS_ATTENTION'
  /** Past the booking horizon: the diary that far out is not real yet. */
  | 'DEFERRED'
  /** The branch is shut that day. */
  | 'CLOSED';

export interface SeriesPreviewView {
  readonly anchorDay: string;
  readonly horizonEnd: string;
  readonly complete: boolean;
  readonly explanation: string;
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly occurrences: readonly {
    readonly index: number;
    readonly day: string;
    readonly wantedStart: string;
    readonly wantedStartMin: number;
    /** Set when the month had no such date and it fell back. */
    readonly movedFromDayOfMonth: number | null;
    readonly verdict: Verdict;
    readonly feasible: boolean;
    /** Where it would actually land. Null when it would not. */
    readonly start: string | null;
    readonly startMin: number | null;
    readonly staffId: string | null;
    readonly rung: Shouted<
      | 'same_time_same_professional'
      | 'same_time_any_professional'
      | 'small_shift'
      | 'nearest_in_day'
    > | null;
    /** Why not, in the sentence the desk would be shown. */
    readonly why: string | null;
    readonly alternatives: readonly {
      readonly start: string;
      readonly startMin: number;
      readonly staffId: string;
      readonly distanceMin: number;
    }[];
  }[];
  readonly advisory: string;
}

/**
 * Every occurrence this series would create, and what would happen to each.
 *
 * WRITES NOTHING. It is the answer to "if I commit to Tuesdays at six, what
 * actually happens?" -- asked before the series exists, when the answer can
 * still change the plan. A desk that finds out in eight weeks that half the
 * autumn is unseatable has learned it too late.
 *
 * It runs the materialiser's OWN read half (candidatesFor) and the same
 * ladder, so a preview that says a date is fine and a nightly job that then
 * refuses it can only mean the diary moved -- not that two implementations
 * disagreed.
 */
@Injectable()
export class SeriesPreviewHandler {
  constructor(private readonly materialiser: MaterialiseSeriesHandler) {}

  async execute(q: SeriesPreviewQuery): Promise<SeriesPreviewView> {
    const expansion = expandSeries(
      {
        anchor: q.anchorDay,
        startMin: q.startMin,
        pattern: q.pattern,
        end: q.end,
      },
      {
        from: q.from,
        horizonDays: q.horizonDays ?? SERIES_HORIZON_DAYS,
      },
    );

    // The shape candidatesFor expects. No row exists -- nothing is written --
    // so this is the definition standing in for one.
    const asSeries = {
      id: 'preview',
      branchId: q.branchId,
      customerId: q.customerId,
      startMin: q.startMin,
      autoConfirmRule: 'auto_confirm_on_schedule' as const,
      status: 'active' as const,
      serviceId: q.serviceId,
      preferredStaffId: q.preferredStaffId,
      baselinePriceFils: 0,
      grandfathered: false,
      courseTotalNetFils: null,
      courseVisits: null,
      courseDrawn: 0,
      materialisedThrough: null,
    };

    const counts: Record<Verdict, number> = {
      EXACT: 0,
      REPAIRABLE: 0,
      NEEDS_ATTENTION: 0,
      DEFERRED: 0,
      CLOSED: 0,
    };

    const occurrences = [];
    for (const occ of expansion.occurrences) {
      const daysAhead = daysBetween(q.from, occ.date);
      const base = {
        index: occ.index,
        day: occ.date,
        wantedStart: formatMinute(occ.startMin),
        wantedStartMin: occ.startMin,
        movedFromDayOfMonth: occ.movedFromDayOfMonth,
        alternatives: [],
      };

      if (daysAhead > BOOKING_HORIZON_DAYS) {
        counts.DEFERRED += 1;
        occurrences.push({
          ...base,
          verdict: 'DEFERRED' as const,
          feasible: false,
          start: null,
          startMin: null,
          staffId: null,
          rung: null,
          why:
            `${daysAhead} days out, past the ${BOOKING_HORIZON_DAYS}-day ` +
            'booking horizon. The nightly materialiser will place it when ' +
            'the diary reaches it.',
        });
        continue;
      }

      const read = await this.materialiser.candidatesFor(
        asSeries,
        { plannedDay: occ.date, plannedStartMin: occ.startMin },
        q.from,
      );

      if (read.kind !== 'ok') {
        const closed = read.kind === 'closed';
        counts[closed ? 'CLOSED' : 'NEEDS_ATTENTION'] += 1;
        occurrences.push({
          ...base,
          verdict: (closed ? 'CLOSED' : 'NEEDS_ATTENTION') as Verdict,
          feasible: false,
          start: null,
          startMin: null,
          staffId: null,
          rung: null,
          why: closed ? read.reason : 'That service does not exist here.',
        });
        continue;
      }

      const decision = repairOccurrence({
        originalStartMin: occ.startMin,
        incumbentStaffId: q.preferredStaffId ?? '',
        candidates: read.candidates,
        daysAhead,
        bookingHorizonDays: BOOKING_HORIZON_DAYS,
      });

      if (decision.kind === 'deferred') {
        counts.DEFERRED += 1;
        occurrences.push({
          ...base,
          verdict: 'DEFERRED' as const,
          feasible: false,
          start: null,
          startMin: null,
          staffId: null,
          rung: null,
          why: decision.explanation,
        });
        continue;
      }

      if (decision.kind === 'needs_attention') {
        counts.NEEDS_ATTENTION += 1;
        occurrences.push({
          ...base,
          verdict: 'NEEDS_ATTENTION' as const,
          feasible: false,
          start: null,
          startMin: null,
          staffId: null,
          rung: null,
          why: decision.explanation,
          alternatives: decision.alternatives.map((a) => ({
            start: formatMinute(a.startMin),
            startMin: a.startMin,
            staffId: a.staffId,
            distanceMin: a.distanceMin,
          })),
        });
        continue;
      }

      const exact = decision.offer.startMin === occ.startMin;
      counts[exact ? 'EXACT' : 'REPAIRABLE'] += 1;
      occurrences.push({
        ...base,
        verdict: (exact ? 'EXACT' : 'REPAIRABLE') as Verdict,
        feasible: true,
        start: formatMinute(decision.offer.startMin),
        startMin: decision.offer.startMin,
        staffId: decision.offer.staffId,
        rung: shout(decision.rung),
        why: exact ? null : decision.explanation,
      });
    }

    return {
      anchorDay: q.anchorDay,
      horizonEnd: expansion.horizonEnd,
      complete: expansion.complete,
      explanation: expansion.explanation,
      counts,
      occurrences,
      advisory:
        'A dry run. Nothing is written and nothing is held, so every date ' +
        'here is advisory until the series is created.',
    };
  }
}
