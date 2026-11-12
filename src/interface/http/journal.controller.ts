import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import {
  BookingJournalHandler,
  type BookingJournalView,
} from '@application/queries/booking-journal.handler';
import { JournalSyncRepository } from '@infrastructure/persistence/journal-sync.repository';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
import { manager } from './money.controller';

/**
 * What a booking's money did to the salon's books. The entries are read
 * from the platform, which owns the general ledger; booking-api adds only
 * how far each money movement has got toward it.
 */
@ApiTags('journal')
@Controller('bookings')
@DeskOnly()
export class BookingJournalController {
  constructor(private readonly journal: BookingJournalHandler) {}

  @Get(':id/journal')
  @ApiOperation({
    summary: "A booking's general-ledger entries",
    description:
      'entries: the journal entries this booking produced, read from the ' +
      "platform's general ledger, oldest first (minor units). movements: " +
      'every money movement on the booking with its sync status -- pending, ' +
      'posted, parked (with the reason) or skipped -- and, for one not yet ' +
      'posted, the entry it will post.',
  })
  @ApiOkResponse({ description: 'The movements and their entries.' })
  journalFor(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<BookingJournalView> {
    return this.journal.execute(id);
  }
}

export class RequeueDto {
  @ApiPropertyOptional({
    description:
      'Only rows parked with this code (ACCOUNT_NOT_FOUND, INVALID_ARGUMENT, ' +
      'NO_MAPPING, ...).',
    example: 'ACCOUNT_NOT_FOUND',
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({
    description: 'Only these money movements, by ledger entry id.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids?: string[];
}

@ApiTags('journal')
@Controller('journal')
@DeskOnly()
export class JournalSyncController {
  constructor(private readonly rows: JournalSyncRepository) {}

  @Post('requeue')
  @ApiOperation({
    summary: 'Send parked money movements again, once the cause is fixed',
    description:
      'MANAGER ONLY. A parked movement was refused by the platform (an ' +
      'account missing, say) or had no account mapping. Nothing reached the ' +
      'ledger, so it can safely go again; the entry is rebuilt from the ' +
      'movement under the current mapping. Narrow by code and/or ids; ' +
      'neither requeues every parked movement.',
  })
  @ApiOkResponse({ description: '{ requeued: n }' })
  async requeue(
    @Body() dto: RequeueDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ requeued: number }> {
    manager(actor, 'Only a manager may requeue journal postings.');
    const requeued = await this.rows.requeue({
      code: dto.code ?? null,
      ids: dto.ids ?? [],
    });
    return { requeued };
  }
}
