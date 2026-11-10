import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/persistence/prisma.service';
import { OutboxRelay } from '../../infrastructure/messaging/outbox-relay.service';
import { AuthService } from '../../auth/auth.service';
import {
  JournalSyncRepository,
  type JournalSyncStats,
} from '../../infrastructure/persistence/journal-sync.repository';
import { journalPostingEnabled } from '@application/commands/journal-sync.flag';
import {
  PosTicketSyncRepository,
  type PosTicketSyncStats,
} from '../../infrastructure/persistence/pos-ticket-sync.repository';
import { posTicketSyncEnabled } from '@application/commands/pos-ticket-sync.flag';
import {
  ReminderHealth,
  type ReminderHealthView,
} from '../../infrastructure/scheduling/reminder-health';

interface OutboxHealth {
  readonly pending: number;
  readonly stuck: number;
  readonly oldestUnpublishedSeconds: number | null;
  readonly publishedTotal: number;
  readonly failedTotal: number;
}

/**
 * The dependency behind every customer token.
 *
 * `address` is reported because the rail is useless without it: "unreachable"
 * tells an operator to go somewhere, and this says where.
 */
interface CustomerAuthHealth {
  readonly status: 'ok' | 'unreachable';
  readonly address: string;
  readonly latencyMs: number | null;
  readonly error?: string;
}

/**
 * Money rows on their way to the platform's general ledger. `parked` is the
 * number to alert on: each one is money that will not reach the books until
 * somebody acts. `oldestPendingSeconds` growing means the platform is
 * unreachable (or sending is switched off, which `sendingEnabled` says).
 */
interface JournalHealth extends JournalSyncStats {
  readonly sendingEnabled: boolean;
}

/**
 * Booking events on their way to the platform's POS (check-in opens a till
 * ticket). `parked` is the number to alert on: each is a visit the till
 * cannot charge, or a ticket it cannot void, until somebody acts.
 */
interface PosTicketSyncHealth extends PosTicketSyncStats {
  readonly sendingEnabled: boolean;
}

/** Postgres and the queues that live in it: one rail. */
interface DatabaseHealth {
  readonly database: string;
  readonly databaseLatencyMs: number | null;
  readonly outbox?: OutboxHealth;
  readonly journal?: JournalHealth;
  readonly posTicketSync?: PosTicketSyncHealth;
  readonly error?: string;
}

interface HealthView {
  readonly status: string;
  readonly database: string;
  readonly databaseLatencyMs: number | null;
  readonly uptimeSeconds: number;
  readonly customerAuth: CustomerAuthHealth;
  readonly outbox?: OutboxHealth;
  /** The reminder pipeline: ladder, delivery queue, dispatcher. */
  readonly reminders: ReminderHealthView;
  readonly journal?: JournalHealth;
  readonly posTicketSync?: PosTicketSyncHealth;
  readonly error?: string;
}

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
    private readonly consumerAuth: AuthService,
    private readonly reminders: ReminderHealth,
    private readonly journal: JournalSyncRepository,
    private readonly posSync: PosTicketSyncRepository,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Is the service up, can it reach its database and the consumer API, ' +
      'is the outbox draining',
    description:
      'Used by Docker Swarm to decide whether to route traffic here. A process ' +
      'that is running but cannot reach Postgres is not healthy.\n\n' +
      'The number to alert on is oldestUnpublishedSeconds, not pending. A ' +
      'backlog of five thousand that is draining is fine; a backlog of one ' +
      'stuck for an hour means a customer is not getting their reminder.\n\n' +
      'customerAuth is the consumer API, which every customer token is ' +
      'checked against over gRPC. Unreachable means customer requests are ' +
      'getting 503 and staff requests are unaffected, because staff tokens ' +
      'are verified locally. It is reported here so that is known before a ' +
      'customer finds it.\n\n' +
      'reminders is the reminder pipeline: the ladder that claims, the ' +
      'delivery queue, and the dispatcher that sends push and email. Alert on ' +
      'reminders.queue.oldestDueSeconds: a due reminder waiting minutes means ' +
      'nothing is dispatching. reminders.delivery is off until ' +
      'REMINDER_DELIVERY=true.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        database: 'ok',
        databaseLatencyMs: 1.24,
        uptimeSeconds: 42,
        customerAuth: {
          status: 'ok',
          address: '10.0.1.250:50051',
          latencyMs: 3,
        },
        outbox: {
          pending: 0,
          stuck: 0,
          oldestUnpublishedSeconds: null,
          publishedTotal: 6,
          failedTotal: 0,
        },
        journal: {
          waitingForTenant: 0,
          pending: 0,
          parked: 0,
          oldestPendingSeconds: null,
          sendingEnabled: true,
        },
        posTicketSync: {
          waitingForTenant: 0,
          pending: 0,
          parked: 0,
          oldestPendingSeconds: null,
          sendingEnabled: false,
        },
      },
    },
  })
  async check(): Promise<HealthView> {
    const uptimeSeconds = Math.round(process.uptime());

    // Both rails, concurrently and independently. A health check is a report
    // on several things at once, so one dead dependency must not decide what
    // is known about the others: the database being down should not blank the
    // auth rail, and the probe deliberately never rejects, so it does not.
    const [db, customerAuth, reminders] = await Promise.all([
      this.databaseRail(),
      this.customerAuthRail(),
      // Informational, not a vote: a reminder backlog is something to alert
      // on (queue.oldestDueSeconds), not a reason to pull this replica out of
      // rotation -- serving bookings does not depend on it.
      this.reminders.report(),
    ]);

    // Every rail votes, and any one of them not being ok is degraded. The
    // check is written this way rather than as one boolean expression so that
    // adding the next rail is adding a line, not remembering to widen a
    // condition that already reads as if it covered everything.
    const degraded =
      db.database !== 'ok' ||
      customerAuth.status !== 'ok' ||
      (db.outbox?.stuck ?? 0) > 0 ||
      (db.journal?.parked ?? 0) > 0 ||
      (db.posTicketSync?.parked ?? 0) > 0;

    return {
      status: degraded ? 'degraded' : 'ok',
      ...db,
      uptimeSeconds,
      customerAuth,
      reminders,
    };
  }

  /** Postgres, and the outbox that only exists if Postgres answered. */
  private async databaseRail(): Promise<DatabaseHealth> {
    try {
      const databaseLatencyMs = await this.prisma.ping();
      return {
        database: 'ok',
        databaseLatencyMs,
        outbox: await this.relay.stats(),
        journal: {
          ...(await this.journal.stats()),
          sendingEnabled: journalPostingEnabled(),
        },
        posTicketSync: {
          ...(await this.posSync.stats()),
          sendingEnabled: posTicketSyncEnabled(),
        },
      };
    } catch (e) {
      return {
        database: 'unreachable',
        databaseLatencyMs: null,
        error: e instanceof Error ? e.message : 'unknown',
      };
    }
  }

  private async customerAuthRail(): Promise<CustomerAuthHealth> {
    const probe = await this.consumerAuth.probe();
    return {
      status: probe.reachable ? 'ok' : 'unreachable',
      address: probe.address,
      latencyMs: probe.latencyMs,
      ...(probe.error === undefined ? {} : { error: probe.error }),
    };
  }
}
