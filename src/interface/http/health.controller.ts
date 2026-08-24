import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/persistence/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Is the service up and can it reach its database',
    description:
      'Used by Docker Swarm to decide whether to route traffic here. ' +
      'A process that is running but cannot reach Postgres is not healthy.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        database: 'ok',
        databaseLatencyMs: 1.24,
        uptimeSeconds: 42,
      },
    },
  })
  async check(): Promise<{
    status: string;
    database: string;
    databaseLatencyMs: number | null;
    uptimeSeconds: number;
    error?: string;
  }> {
    const uptimeSeconds = Math.round(process.uptime());
    try {
      const databaseLatencyMs = await this.prisma.ping();
      return { status: 'ok', database: 'ok', databaseLatencyMs, uptimeSeconds };
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
