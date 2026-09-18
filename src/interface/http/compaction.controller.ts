import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotentInterceptor } from './idempotent.interceptor';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { BranchId } from './branch.decorator';
import {
  CompactionHandler,
  type ApplyCompactionView,
  type CompactionView,
} from '@application/commands/compaction.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A QUERY DTO, not three bare @Query() strings.
 *
 * `GET /compaction` with no `tradingDay` used to reach the handler with
 * `undefined` and die inside a date cast: 500 BOOKING_STATE_INVALID,
 * "Something went wrong", no field named. A DTO puts the ValidationPipe in
 * front of it, so the same mistake is a 400 that says `tradingDay`.
 */
export class CompactionPlanQuery {
  @ApiProperty({ example: '2026-09-04' })
  @Matches(DAY, { message: 'tradingDay must be YYYY-MM-DD' })
  tradingDay!: string;

  @ApiPropertyOptional({
    description: 'OPTIONAL. See the note on the apply body.',
  })
  @IsOptional()
  @IsString()
  branchId?: string;
}

export class ApplyCompactionDto {
  @ApiPropertyOptional({
    description:
      'OPTIONAL. The branch is taken from the token when the token names ' +
      'one; send this only for a token scoped to no particular branch. ' +
      'Sending a branch the token does not cover is 403 ' +
      'BOOKING_BRANCH_MISMATCH rather than a write nobody can read back.',
  })
  @IsOptional()
  @IsString()
  branchId?: string;

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
/**
 * TWO PATHS, ONE CONTROLLER.
 *
 * The front-end contract mounts everything under /v1/bookings/*; this
 * service mounted by aggregate. Nest takes an array of controller paths, so
 * both spellings reach the SAME handlers -- no second controller, no
 * forwarding, nothing to drift. The aggregate path stays because existing
 * clients use it.
 */
@Controller(['compaction', 'bookings/compaction'])
/**
 * IDEMPOTENT WHERE A KEY IS SENT.
 *
 * The front end mints an Idempotency-Key per tap on these routes. Without
 * this, a retry on a flaky connection moved a booking twice, or seated a
 * walk-in twice. See idempotent.interceptor.ts for what it does and does
 * not promise.
 */
@UseInterceptors(IdempotentInterceptor)
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
  @ApiQuery({ name: 'tradingDay', example: '2026-09-04' })
  @ApiQuery({ name: 'branchId', required: false })
  async plan(
    @BranchId() branchId: string,
    @Query() q: CompactionPlanQuery,
  ): Promise<CompactionView> {
    return this.handler.plan(branchId, q.tradingDay);
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
    @BranchId() branchId: string,
  ): Promise<ApplyCompactionView> {
    return this.handler.apply(branchId, dto.tradingDay, dto.codes, {
      kind: actor.kind,
      id: actor.id,
    });
  }
}
