import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PosTicketSyncRepository } from '@infrastructure/persistence/pos-ticket-sync.repository';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { manager } from './money.controller';
import { RequeueDto } from './journal.controller';

/**
 * The till's queue, for the person who fixes what it refused. Counts and
 * the oldest wait are on /health (posTicketSync).
 */
@ApiTags('pos')
@Controller('pos-ticket-sync')
@DeskOnly()
export class PosTicketSyncController {
  constructor(private readonly rows: PosTicketSyncRepository) {}

  @Post('requeue')
  @ApiOperation({
    summary: 'Send parked booking events to the till again, once fixed',
    description:
      'MANAGER ONLY. A parked event was refused by the platform POS (a ' +
      'service the tenant does not own, an unknown branch, ...) and holds ' +
      'back every later event of its booking. Nothing reached the till, so ' +
      'it can safely go again; the request is rebuilt from the booking. ' +
      'Narrow by code (POS_LINE_CATALOG, ...) and/or ids; neither requeues ' +
      'every parked event.',
  })
  @ApiOkResponse({ description: '{ requeued: n }' })
  async requeue(
    @Body() dto: RequeueDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ requeued: number }> {
    manager(actor, 'Only a manager may requeue till events.');
    const requeued = await this.rows.requeue({
      code: dto.code ?? null,
      ids: dto.ids ?? [],
    });
    return { requeued };
  }
}
