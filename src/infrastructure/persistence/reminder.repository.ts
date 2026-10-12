import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import {
  LADDER,
  LADDER_STATUSES,
  claimVerdict,
  earlierColumns,
  paymentPending,
  type RungSpec,
} from '@domain/booking/reminders';

/** One booking claimed for one rung. Named: a heredoc eats a trailing `<`. */
interface ClaimedRow {
  id: string;
  code: string;
  start_at: Date;
  customer_id: string;
  payment_status: string;
  reminded_24h_at: Date | null;
  reminded_3h_at: Date | null;
  nudged_15m_at: Date | null;
}

export interface RungResult {
  readonly rung: string;
  readonly sent: number;
  readonly skipped: number;
  /** Claims given back because they were not this rung's turn. */
  readonly released: number;
}

@Injectable()
export class ReminderRepository {
  private static readonly log = new Logger(ReminderRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim and dispatch one rung of the ladder.
   *
   * THE CLAIM IS THE WHOLE DESIGN, and it is one statement:
   *
   *   UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING
   *
   * Two replicas run this scheduler. A SELECT followed by an UPDATE would let
   * both read the same booking and both send, so every customer gets every
   * message twice. UPDATE ... RETURNING hands back only the rows THIS
   * transaction actually claimed, so the work divides itself with no lock
   * table, no leader election and no coordination.
   *
   * SKIP LOCKED is what makes the second replica useful rather than blocked:
   * it takes the next batch instead of waiting for the first.
   *
   * The outbox row is written in the SAME transaction as the claim. A crash
   * between them is impossible: either both happened or neither did, and the
   * relay delivers whatever committed.
   */
  async runRung(spec: RungSpec, nowMs: number): Promise<RungResult> {
    const column = COLUMN_SQL[spec.column];
    const horizon = new Date(nowMs + spec.leadMs);
    // ONE RUNG AT A TIME, IN ORDER. A rung is claimable only once every
    // earlier rung is stamped (domain `earlierColumns`, the same predicate as
    // `claimable`), so a booking created or moved between two passes of a
    // tick waits one tick for its earlier rungs to be judged, instead of
    // having this rung stamped while `due` was talking about another.
    const earlierStamped = earlierColumns(spec)
      .map((c) => `AND ${COLUMN_SQL[c]} IS NOT NULL`)
      .join(' ');

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRawUnsafe<ClaimedRow[]>(
        `
        UPDATE booking
           SET ${column} = now()
         WHERE id IN (
           SELECT id FROM booking
            WHERE ${column} IS NULL
              ${earlierStamped}
              AND status = ANY($1::booking_status[])
              AND start_at <= $2
            ORDER BY start_at
            LIMIT 200
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, code, start_at, customer_id, payment_status,
                  reminded_24h_at, reminded_3h_at, nudged_15m_at`,
        [...LADDER_STATUSES],
        horizon,
      );

      let sent = 0;
      let skipped = 0;
      const released: string[] = [];

      for (const row of claimed) {
        // The claim is deliberately broad: it grabs everything past the lead
        // time. The DOMAIN decides whether this rung sends or skips, so a
        // booking made inside the window is marked without being messaged --
        // and it answers for THIS rung only.
        const verdict = claimVerdict(
          spec,
          {
            startAtMs: row.start_at.getTime(),
            reminded24hAt: row.reminded_24h_at?.getTime() ?? null,
            reminded3hAt: row.reminded_3h_at?.getTime() ?? null,
            nudged15mAt: row.nudged_15m_at?.getTime() ?? null,
          },
          nowMs,
        );

        if (verdict.kind === 'release') {
          // Unreachable while the claim keeps its order. If it is ever
          // reached, the stamp goes back rather than recording a rung as
          // handled that nothing judged.
          released.push(row.id);
          ReminderRepository.log.error(
            `${spec.rung} claim on ${row.code} released: ${verdict.why}`,
          );
          continue;
        }

        if (verdict.kind === 'skip') {
          skipped += 1;
          continue;
        }

        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: row.id,
            eventType: `reminder.${spec.rung}`,
            payload: {
              code: row.code,
              rung: spec.rung,
              purpose: spec.purpose,
              // The start this reminder was claimed FOR. Delivery compares it
              // with the booking at send time: a booking moved since then is
              // superseded, and the moved booking gets its own ladder.
              startAt: row.start_at.toISOString(),
              customerId: row.customer_id,
              paymentPending: paymentPending(row.payment_status),
            },
          },
        });
        sent += 1;
      }

      if (released.length > 0) {
        await tx.$executeRawUnsafe(
          `UPDATE booking SET ${column} = NULL WHERE id = ANY($1::uuid[])`,
          released,
        );
      }

      if (sent > 0 || skipped > 0 || released.length > 0) {
        ReminderRepository.log.log(
          `${spec.rung}: ${sent} sent, ${skipped} passed over` +
            (released.length > 0 ? `, ${released.length} released` : ''),
        );
      }
      return { rung: spec.rung, sent, skipped, released: released.length };
    });
  }

  /** Every rung, furthest out first, so one tick can drain a late booking. */
  async runLadder(nowMs: number = Date.now()): Promise<RungResult[]> {
    const out: RungResult[] = [];
    for (const spec of LADDER) {
      out.push(await this.runRung(spec, nowMs));
    }
    return out;
  }
}

const COLUMN_SQL: Record<RungSpec['column'], string> = {
  reminded24hAt: 'reminded_24h_at',
  reminded3hAt: 'reminded_3h_at',
  nudged15mAt: 'nudged_15m_at',
};
