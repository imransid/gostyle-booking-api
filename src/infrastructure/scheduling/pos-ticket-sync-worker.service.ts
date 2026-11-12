import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  PosTicketSyncHandler,
  type PosSettleSweepReport,
  type PosTicketSyncRunReport,
} from '@application/commands/pos-ticket-sync.handler';
import { posTicketSyncEnabled } from '@application/commands/pos-ticket-sync.flag';

/**
 * Every 5s. A checked-in customer walks to the chair in about that long,
 * and the cashier should find the ticket on the till by then; an idle tick
 * is one lookup on an empty partial index.
 */
export const POS_TICKET_SYNC_MS = 5_000;

/**
 * Every 5 minutes: the safety net for a paid callback that never arrived.
 * It only looks at visits completed half an hour ago or more, so nothing is
 * gained by asking more often.
 */
export const POS_SETTLE_SWEEP_MS = 5 * 60_000;

/**
 * The clock for PosTicketSyncHandler: send queued booking events to the
 * platform's POS, and settle visits whose paid callback was lost. Whether
 * anything is sent is the handler's switch (POS_TICKET_SYNC_ENABLED), read on
 * every tick.
 */
@Injectable()
export class PosTicketSyncWorker implements OnModuleInit {
  private static readonly log = new Logger(PosTicketSyncWorker.name);
  private running = false;
  private sweeping = false;
  private runs = 0;
  private last: PosTicketSyncRunReport | null = null;
  private lastSweep: PosSettleSweepReport | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly handler: PosTicketSyncHandler) {}

  onModuleInit(): void {
    const on = posTicketSyncEnabled();
    PosTicketSyncWorker.log.log(
      `POS ticket sync armed, every ${POS_TICKET_SYNC_MS / 1000}s ` +
        `(${on ? 'ON' : 'off: POS_TICKET_SYNC_ENABLED is not true'})`,
    );
    if (!on) return;

    // The till looks a service and a stylist up by the PLATFORM'S ids. With
    // either catalogue on fixtures, every open carries ids the platform has
    // never seen: services park as POS_LINE_CATALOG, staff go unassigned.
    for (const flag of ['STAFF_FROM_PLATFORM', 'SERVICES_FROM_PLATFORM']) {
      if ((process.env[flag] ?? '').trim().toLowerCase() !== 'true') {
        PosTicketSyncWorker.log.warn(
          `POS ticket sync is on but ${flag} is not true: tickets will ` +
            'carry fixture ids the platform cannot resolve.',
        );
      }
    }
    if ((process.env.PLATFORM_INTERNAL_KEY ?? '').trim() === '') {
      PosTicketSyncWorker.log.error(
        'POS ticket sync is on but PLATFORM_INTERNAL_KEY is not set: nothing ' +
          'reaches the till until it is (rows wait, and are retried).',
      );
    }
  }

  @Interval('pos-ticket-sync', POS_TICKET_SYNC_MS)
  async tick(): Promise<void> {
    // A slow batch (the platform timing out) must never overlap itself.
    if (this.running) return;
    this.running = true;
    try {
      this.last = await this.handler.run();
      this.runs += 1;
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // A failure HERE is the database, not the platform: per-row failures
      // are handled, logged and backed off inside the run. First failure,
      // then every thirtieth.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        PosTicketSyncWorker.log.error(
          `POS ticket sync tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  @Interval('pos-settle-sweep', POS_SETTLE_SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      this.lastSweep = await this.handler.sweepUnsettled();
    } catch (e) {
      PosTicketSyncWorker.log.error(
        `POS settle sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /** What the last runs did, so the worker is observable rather than assumed. */
  stats(): {
    intervalMs: number;
    runs: number;
    last: PosTicketSyncRunReport | null;
    lastSweep: PosSettleSweepReport | null;
    consecutiveFailures: number;
  } {
    return {
      intervalMs: POS_TICKET_SYNC_MS,
      runs: this.runs,
      last: this.last,
      lastSweep: this.lastSweep,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
