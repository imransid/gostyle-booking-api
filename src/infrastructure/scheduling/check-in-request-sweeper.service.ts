import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CheckInRequestRepository } from '../persistence/check-in-request.repository';

export const CHECK_IN_LAPSE_SWEEP_MS = 60_000;

/**
 * Ends the self check-in requests nobody answered.
 *
 * Once a minute, every WAITING request is asked domain lapseOf's question:
 *
 *   closed    its booking is no longer CONFIRMED (the desk used the ordinary
 *             check-in, or it was cancelled or moved)
 *   expired   still CONFIRMED at the booking's end time: nobody answered
 *
 * Without this a request would wait forever, and the reception list would
 * fill with people who left hours ago.
 *
 * AN EXPIRED REQUEST IS NOT A NO-SHOW. The auto no-show sweeper still leaves
 * that booking alone (the customer said they arrived); the desk closes it by
 * hand.
 *
 * Always on, with or without the routes' flag: with no requests it does
 * nothing, and with the flag switched off mid-day the requests already
 * waiting still end properly.
 */
@Injectable()
export class CheckInRequestSweeper implements OnModuleInit {
  private static readonly log = new Logger(CheckInRequestSweeper.name);
  private running = false;
  private consecutiveFailures = 0;

  constructor(private readonly requests: CheckInRequestRepository) {}

  onModuleInit(): void {
    CheckInRequestSweeper.log.log(
      `Check-in request lapse job armed, every ${CHECK_IN_LAPSE_SWEEP_MS / 1000}s`,
    );
  }

  @Interval('check-in-request-lapse', CHECK_IN_LAPSE_SWEEP_MS)
  async sweep(nowMs: number = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const lapsed = await this.requests.lapseWaiting(nowMs);
      for (const row of lapsed) {
        CheckInRequestSweeper.log.log(
          `${row.code} check-in request ${row.id} ${row.to}`,
        );
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        CheckInRequestSweeper.log.error(
          `Lapse sweep failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }
}
