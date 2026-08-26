import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LADDER, due, type RungSpec } from '@domain/booking/reminders';

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
}

/** Only a live booking is worth reminding. */
const LIVE = ['confirmed', 'pending_payment'];

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

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRawUnsafe<ClaimedRow[]>(
        `
        UPDATE booking
           SET ${column} = now()
         WHERE id IN (
           SELECT id FROM booking
            WHERE ${column} IS NULL
              AND status = ANY($1::booking_status[])
              AND start_at <= $2
            ORDER BY start_at
            LIMIT 200
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, code, start_at, customer_id, payment_status,
                  reminded_24h_at, reminded_3h_at, nudged_15m_at`,
        LIVE,
        horizon,
      );

      let sent = 0;
      let skipped = 0;

      for (const row of claimed) {
        // The claim is deliberately broad: it grabs everything past the lead
        // time. The DOMAIN decides whether this rung is the right one, so a
        // booking made inside the window is marked without being messaged.
        const verdict = due(
          {
            startAtMs: row.start_at.getTime(),
            // The claim already stamped this rung, so read it as outstanding
            // and let `due` judge the window rather than the flag.
            reminded24hAt: asMs(
              row.reminded_24h_at,
              spec.column,
              'reminded24hAt',
            ),
            reminded3hAt: asMs(row.reminded_3h_at, spec.column, 'reminded3hAt'),
            nudged15mAt: asMs(row.nudged_15m_at, spec.column, 'nudged15mAt'),
          },
          nowMs,
        );

        if (verdict.kind !== 'send') {
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
              startAt: row.start_at.toISOString(),
              customerId: row.customer_id,
              // "with a payment prompt when anything is pending"
              paymentPending: row.payment_status === 'unpaid',
            },
          },
        });
        sent += 1;
      }

      if (sent > 0 || skipped > 0) {
        ReminderRepository.log.log(
          `${spec.rung}: ${sent} sent, ${skipped} passed over`,
        );
      }
      return { rung: spec.rung, sent, skipped };
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

/**
 * The claim stamped this rung's column a microsecond ago, so reading it back
 * would tell `due` the rung is already handled and it would answer 'nothing'
 * for every row. This rung is presented as outstanding; the others are read
 * as they are.
 */
function asMs(
  value: Date | null,
  claimedColumn: RungSpec['column'],
  thisColumn: RungSpec['column'],
): number | null {
  if (claimedColumn === thisColumn) return null;
  return value === null ? null : value.getTime();
}
