import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/persistence/prisma.service';
import { OutboxRelay } from '../../infrastructure/messaging/outbox-relay.service';

interface OutboxHealth {
  readonly pending: number;
  readonly stuck: number;
  readonly oldestUnpublishedSeconds: number | null;
  readonly publishedTotal: number;
  readonly failedTotal: number;
}

interface HealthView {
  readonly status: string;
  readonly database: string;
  readonly databaseLatencyMs: number | null;
  readonly uptimeSeconds: number;
  readonly outbox?: OutboxHealth;
  readonly error?: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Is the service up, can it reach its database, is the outbox draining',
    description:
      'Used by Docker Swarm to decide whether to route traffic here. A process ' +
      'that is running but cannot reach Postgres is not healthy.\n\n' +
      'The number to alert on is oldestUnpublishedSeconds, not pending. A ' +
      'backlog of five thousand that is draining is fine; a backlog of one ' +
      'stuck for an hour means a customer is not getting their reminder.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        database: 'ok',
        databaseLatencyMs: 1.24,
        uptimeSeconds: 42,
        outbox: {
          pending: 0,
          stuck: 0,
          oldestUnpublishedSeconds: null,
          publishedTotal: 6,
          failedTotal: 0,
        },
      },
    },
  })
  async check(): Promise<HealthView> {
    const uptimeSeconds = Math.round(process.uptime());
    try {
      const databaseLatencyMs = await this.prisma.ping();
      const outbox = await this.relay.stats();
      return {
        status: outbox.stuck > 0 ? 'degraded' : 'ok',
        database: 'ok',
        databaseLatencyMs,
        uptimeSeconds,
        outbox,
      };
    } catch (e) {
      return {
        status: 'degraded',
        database: 'unreachable',
        databaseLatencyMs: null,
        uptimeSeconds,
        error: e instanceof Error ? e.message : 'unknown',
      };
    }
  }
}
