import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotentInterceptor } from './idempotent.interceptor';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { DeskActionsHandler } from '@application/commands/desk-actions.handler';
import { DAY_END_MIN, DAY_START_MIN } from '@domain/availability/grid';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
import { CustomerRiskDto } from './read-model.dto';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class MoveBookingDto {
  @ApiProperty({ example: '2026-07-13' })
  @Matches(DAY)
  date!: string;

  @ApiPropertyOptional({
    example: '16:00',
    description: 'Branch-local. Send this or startMin.',
  })
  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @ApiPropertyOptional({ example: 960, description: 'Minutes from midnight.' })
  @IsOptional()
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  startMin?: number;

  @ApiPropertyOptional({
    example: 'maya',
    description: 'Drop onto another column. Omit to keep the same person.',
  })
  @IsOptional()
  @IsString()
  staffId?: string;

  @ApiPropertyOptional({
    example: 'regular client, squeezing in',
    description: 'MANAGER ONLY. Forces the move past capacity, and is audited.',
  })
  @IsOptional()
  @IsString()
  overbookReason?: string;
}

/**
 * Desk actions that had domain code but no URL.
 *
 * @DeskOnly throughout: dragging someone else's appointment across the
 * diary, reading the arrival gates and reading a risk score are all things
 * the salon does, never the customer.
 */
@ApiTags('desk')
/**
 * IDEMPOTENT WHERE A KEY IS SENT.
 *
 * The front end mints an Idempotency-Key per tap on these routes. Without
 * this, a retry on a flaky connection moved a booking twice, or seated a
 * walk-in twice. See idempotent.interceptor.ts for what it does and does
 * not promise.
 */
@UseInterceptors(IdempotentInterceptor)
@Controller('bookings')
@DeskOnly()
export class DeskActionsController {
  constructor(private readonly desk: DeskActionsHandler) {}

  @Post(':id/move')
  @ApiOperation({
    summary: 'Calendar drag-and-drop',
    description:
      'Distinct from reschedule: no hold, no reason ladder. A move to a new ' +
      'TIME on the same professional shifts in place, because a booking ' +
      'nudged fifteen minutes overlaps ITSELF and a hold would be refused by ' +
      'the exclusion constraint against the very booking being moved. A move ' +
      'onto another professional places the hold server-side and moves onto ' +
      'it, so the drag stays one gesture.',
  })
  @ApiOkResponse({ description: 'Moved.' })
  @ApiConflictResponse({
    description: 'Blocked, with the constraint and refreshed offers.',
  })
  move(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: MoveBookingDto,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    return this.desk.move({
      bookingId: id,
      date: dto.date,
      startMin: startMinuteOf(dto),
      staffId: dto.staffId,
      overbookReason: dto.overbookReason,
      actor: actor.kind,
      actorId: actor.id,
    });
  }

  @Get(':id/check-in')
  @ApiOperation({
    summary: 'The arrival gates, evaluated server-side',
    description:
      'The client must not decide whether a visit may start. One gate — ' +
      'CONSENT — reports `passed: null` with reason NOT_MODELLED rather than ' +
      'a true it cannot justify: consent and patch-test records live on the ' +
      'customer service, and inventing a pass is how an untested client gets ' +
      'a colour service.',
  })
  gates(@Param('id', ResourceIdPipe) id: string): Promise<unknown> {
    return this.desk.checkInGates(id);
  }
}

/**
 * The risk screen.
 *
 * A separate controller because it hangs off /v1/customers, not /v1/bookings.
 * It is the ONLY customer route in this service, and it reads through the
 * same port the deposit ladder uses, so the score shown and the score charged
 * cannot disagree.
 */
@ApiTags('desk')
@Controller('customers')
@DeskOnly()
export class CustomerRiskController {
  constructor(private readonly desk: DeskActionsHandler) {}

  @Get(':id/risk')
  @ApiOperation({
    summary: 'The rolling risk score',
    description:
      'Recomputed on every read, never stored. The counts behind the score ' +
      'are reported as null rather than back-solved from it — several ' +
      'histories give the same number, and a plausible guess on a risk ' +
      'screen is worse than an honest gap.',
  })
  @ApiOkResponse({ type: CustomerRiskDto })
  risk(@Param('id') id: string): Promise<unknown> {
    return this.desk.risk(id);
  }
}

/**
 * HH:MM or minutes, one of the two.
 *
 * The contract sends `startTime`; the rest of this API speaks minutes. Both
 * are accepted and folded here so no handler below sees two spellings.
 */
function startMinuteOf(dto: MoveBookingDto): number {
  if (dto.startMin !== undefined) return dto.startMin;
  if (dto.startTime !== undefined) {
    const [h, m] = dto.startTime.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }
  return DAY_START_MIN;
}
