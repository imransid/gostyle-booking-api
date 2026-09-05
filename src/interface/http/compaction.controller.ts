import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';
import {
  CompactionHandler,
  type ApplyCompactionView,
  type CompactionView,
} from '@application/commands/compaction.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ApplyCompactionDto {
  @ApiProperty()
  @IsString()
  branchId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @Matches(DAY)
  tradingDay!: string;

  @ApiProperty({
    example: ['GS-1042'],
    description: 'The booking codes the customers have agreed to move.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes!: string[];
}

/**
 * Diary compaction.
 *
 * Two endpoints on purpose. The plan is a proposal; applying it is a
 * separate act, taken after the customer has agreed on WhatsApp. Anything
 * that both planned and applied in one call would make a consent move
 * without the consent.
 *
 * @DeskOnly because both endpoints act on the SALON's diary, not on one
 * caller's booking: the plan reads the whole day, and applying it moves
 * other customers' appointments. A customer token reached both before this.
 */
@ApiTags('compaction')
@Controller('compaction')
@DeskOnly()
export class CompactionController {
  constructor(private readonly handler: CompactionHandler) {}

  @Get()
  @ApiOperation({
    summary: 'Propose the moves that close the day’s unsellable gaps',
    description:
      'At most three moves, at most 30 minutes each, and only where a move ' +
      'frees more than four stranded minutes. Nothing is applied.',
  })
  @ApiOkResponse({ description: 'The slivers and the proposed consent moves.' })
  async plan(
    @Query('branchId') branchId: string,
    @Query('tradingDay') tradingDay: string,
  ): Promise<CompactionView> {
    return this.handler.plan(branchId, tradingDay);
  }

  @Post('apply')
  @ApiOperation({
    summary: 'Apply the moves the customers agreed to',
    description:
      'The plan is recomputed and every move re-validated against the live ' +
      'masks. A move that has gone stale is skipped and reported, never forced.',
  })
  @ApiOkResponse({
    description: 'What was applied, and what was skipped and why.',
  })
  async apply(
    @Body() dto: ApplyCompactionDto,
    @CurrentActor() actor: Actor,
  ): Promise<ApplyCompactionView> {
    return this.handler.apply(dto.branchId, dto.tradingDay, dto.codes, {
      kind: actor.kind,
      id: actor.id,
    });
  }
}
