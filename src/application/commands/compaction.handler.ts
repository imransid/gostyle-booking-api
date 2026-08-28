import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { CompactionRepository } from '@infrastructure/persistence/compaction.repository';
import { RescheduleRepository } from '@infrastructure/persistence/reschedule.repository';
import {
  planCompaction,
  type CompactionPlan,
  type ProposedMove,
} from '@domain/availability/compaction';
import { formatMinute } from '@domain/availability/grid';
import type { ActorKind } from '@domain/booking/lifecycle';

export interface CompactionView {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly strandedBeforeMin: number;
  readonly strandedAfterMin: number;
  readonly gainMin: number;
  readonly slivers: readonly {
    readonly staffId: string;
    readonly from: string;
    readonly to: string;
    readonly minutes: number;
  }[];
  readonly moves: readonly {
    readonly bookingId: string;
    readonly code: string;
    readonly from: string;
    readonly to: string;
    readonly deltaMin: number;
    readonly gainMin: number;
    readonly note: string;
  }[];
  readonly explanation: string;
}

export interface AppliedMove {
  readonly code: string;
  readonly applied: boolean;
  readonly reason: string;
}

export interface ApplyCompactionView {
  readonly applied: number;
  readonly skipped: number;
  readonly moves: readonly AppliedMove[];
  readonly explanation: string;
}

/**
 * Diary compaction.
 *
 * The plan is a PROPOSAL. Every move is a consent move, so this handler
 * produces something a human takes to the customer, and applying it is a
 * separate call made after they have agreed.
 *
 * Each move is re-validated at apply time against the real masks, because
 * between the plan and the phone call the diary will have moved. A move that
 * has gone stale is skipped and reported rather than forced.
 */
@Injectable()
export class CompactionHandler {
  private static readonly log = new Logger(CompactionHandler.name);

  constructor(
    private readonly repo: CompactionRepository,
    private readonly reschedules: RescheduleRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async plan(branchId: string, tradingDay: string): Promise<CompactionView> {
    const diary = await this.repo.diaryFor(branchId, tradingDay);
    const plan = planCompaction(diary.map((d) => d.booking));
    return this.toView(branchId, tradingDay, plan);
  }

  /**
   * Apply the moves the customer agreed to.
   *
   * The plan is recomputed here rather than trusted from the request. A
   * client holding a five-minute-old plan is holding a claim about a diary
   * that has since changed, and applying it verbatim would move a booking on
   * the strength of arithmetic nobody has checked since.
   */
  async apply(
    branchId: string,
    tradingDay: string,
    codes: readonly string[],
    actor: { kind: ActorKind; id: string | null },
  ): Promise<ApplyCompactionView> {
    const diary = await this.repo.diaryFor(branchId, tradingDay);
    const fresh = planCompaction(diary.map((d) => d.booking));

    const wanted = new Set(codes);
    const results: AppliedMove[] = [];
    let applied = 0;
    let skipped = 0;

    for (const code of wanted) {
      const move = fresh.moves.find((m) => m.code === code);
      if (move === undefined) {
        skipped += 1;
        results.push({
          code,
          applied: false,
          reason:
            'The diary has changed and this move no longer helps. Nothing was moved.',
        });
        continue;
      }

      const done = await this.applyOne(
        branchId,
        tradingDay,
        move,
        diary,
        actor,
      );
      if (done.applied) applied += 1;
      else skipped += 1;
      results.push(done);
    }

    return {
      applied,
      skipped,
      moves: results,
      explanation:
        skipped === 0
          ? `${applied} ${applied === 1 ? 'move' : 'moves'} applied.`
          : `${applied} applied, ${skipped} skipped because the diary had moved on.`,
    };
  }

  private async applyOne(
    branchId: string,
    tradingDay: string,
    move: ProposedMove,
    diary: Awaited<ReturnType<CompactionRepository['diaryFor']>>,
    actor: { kind: ActorKind; id: string | null },
  ): Promise<AppliedMove> {
    const row = diary.find((d) => d.booking.bookingId === move.bookingId);
    if (row === undefined) {
      return {
        code: move.code,
        applied: false,
        reason: 'The booking has gone.',
      };
    }

    // A SHIFT, NOT A HOLD-THEN-MOVE.
    //
    // Every compaction move is small by definition, so the new slot overlaps
    // the booking's OWN current one, and a hold on it is refused by the
    // exclusion constraint against the very booking being moved. The shift
    // takes its atomicity from the transaction instead, and the constraint
    // still has the final word about everybody else -- which is exactly the
    // re-validation the rule asks for.
    const moved = await this.reschedules.shiftInPlace({
      bookingId: move.bookingId,
      tradingDay,
      toStartMin: move.toStartMin,
      // The note records the original and the new time, per the rule.
      reason: `diary compaction: ${formatMinute(move.fromStartMin)} to ${formatMinute(move.toStartMin)}`,
      actor: actor.kind,
      actorId: actor.id,
    });

    if (moved.kind === 'slot_taken') {
      return {
        code: move.code,
        applied: false,
        reason:
          'Somebody took that time while the customer was being asked. Nothing was moved.',
      };
    }
    if (moved.kind !== 'shifted') {
      return {
        code: move.code,
        applied: false,
        reason: `The move was refused (${moved.kind}). Nothing was moved.`,
      };
    }

    CompactionHandler.log.log(
      `Compacted ${move.code}: ${formatMinute(move.fromStartMin)} -> ` +
        `${formatMinute(move.toStartMin)}, ${move.gainMin} stranded minutes freed`,
    );

    return { code: move.code, applied: true, reason: move.note };
  }

  private toView(
    branchId: string,
    tradingDay: string,
    plan: CompactionPlan,
  ): CompactionView {
    return {
      branchId,
      tradingDay,
      strandedBeforeMin: plan.strandedBeforeMin,
      strandedAfterMin: plan.strandedAfterMin,
      gainMin: plan.gainMin,
      slivers: plan.slivers.map((g) => ({
        staffId: g.staffId,
        from: formatMinute(g.fromMin),
        to: formatMinute(g.toMin),
        minutes: g.minutes,
      })),
      moves: plan.moves.map((m) => ({
        bookingId: m.bookingId,
        code: m.code,
        from: formatMinute(m.fromStartMin),
        to: formatMinute(m.toStartMin),
        deltaMin: m.deltaMin,
        gainMin: m.gainMin,
        note: m.note,
      })),
      explanation: plan.explanation,
    };
  }
}
