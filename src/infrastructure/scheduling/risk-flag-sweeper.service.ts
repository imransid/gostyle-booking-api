import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../persistence/prisma.service';

/** 03:00, after the materialiser and well clear of trading. */
export const RISK_FLAG_CRON = '0 3 * * *';

/** Clean visits that lift a manager's require-deposit flag. */
export const SETTLED_VISITS_TO_LIFT = 3;

/**
 * Lifts the require-deposit flag after three settled visits.
 *
 * "That expiry is the server's job" — and until now nothing did it, so a
 * flag set once stayed set forever. A customer who had a bad month two years
 * ago was still paying 50% up front, and the only way off the list was for
 * somebody to remember.
 *
 * WHAT THIS CAN AND CANNOT DO TODAY. The flag lives on the CUSTOMER record,
 * which belongs to another service; this module reads it through a port and
 * has nothing to write to. So the sweep identifies who has earned the lift
 * and EMITS AN EVENT for the customer service to act on, rather than
 * pretending to clear a flag it does not own.
 *
 * That is the honest half of the job, and it is the half that can exist
 * before the customer service has an endpoint. When it does, this consumes
 * it and the event becomes a call.
 */
@Injectable()
export class RiskFlagSweeper {
  private static readonly log = new Logger(RiskFlagSweeper.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(RISK_FLAG_CRON, { name: 'risk-flag-expiry' })
  async sweep(): Promise<void> {
    try {
      const lifted = await this.run();
      if (lifted.length > 0) {
        RiskFlagSweeper.log.log(
          `${lifted.length} customer(s) have earned a deposit-flag lift`,
        );
      }
    } catch (e) {
      RiskFlagSweeper.log.error(
        `Risk-flag sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Customers with three or more settled visits and no recent trouble.
   *
   * A no-show or cancellation INSIDE the qualifying run resets it: three
   * clean visits means three in a row, not three somewhere in a history that
   * also contains two no-shows.
   */
  async run(): Promise<{ customerId: string; settled: number }[]> {
    const rows = await this.prisma.$queryRaw<
      { customer_id: string; settled: bigint }[]
    >`
      WITH recent AS (
        SELECT customer_id, status, start_at,
               row_number() OVER (PARTITION BY customer_id ORDER BY start_at DESC) AS rn
          FROM booking
         WHERE status IN ('settled', 'completed', 'no_show', 'cancelled')
      )
      SELECT customer_id, count(*) AS settled
        FROM recent
       WHERE rn <= ${SETTLED_VISITS_TO_LIFT}
       GROUP BY customer_id
      HAVING count(*) = ${SETTLED_VISITS_TO_LIFT}
         AND count(*) FILTER (
               WHERE status IN ('no_show', 'cancelled')
             ) = 0`;

    for (const r of rows) {
      await this.prisma.eventOutbox.create({
        data: {
          aggregateType: 'customer',
          aggregateId: r.customer_id,
          eventType: 'customer.deposit_flag_liftable',
          payload: {
            customerId: r.customer_id,
            settledVisits: Number(r.settled),
            rule: `${SETTLED_VISITS_TO_LIFT} consecutive settled visits`,
          },
        },
      });
    }

    return rows.map((r) => ({
      customerId: r.customer_id,
      settled: Number(r.settled),
    }));
  }
}
