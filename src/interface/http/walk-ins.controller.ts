import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ResourceIdPipe } from './resource-id.pipe';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  WalkInHandler,
  type WalkInQueueView,
} from '@application/commands/walk-in.handler';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { DeskOnly } from '../../auth/desk-only.decorator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class JoinWalkInDto {
  @ApiProperty()
  @IsString()
  branchId!: string;

  @ApiProperty({ example: '2027-03-05' })
  @Matches(DAY)
  tradingDay!: string;

  @ApiPropertyOptional({ description: 'A registered customer.' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Somebody who just walked in.' })
  @IsOptional()
  @IsString()
  guestName?: string;

  @ApiProperty({
    example: ['colour-and-finish'],
    description: 'Service or PACKAGE ids. Packages are expanded on the way in.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  serviceIds!: string[];

  @ApiProperty({ example: 840, description: 'Minute of day they arrived.' })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  joinedMin!: number;
}

export class SeatWalkInDto {
  @ApiProperty({ example: 900 })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  startMin!: number;

  @ApiProperty({ example: 'maya' })
  @IsString()
  staffId!: string;
}

/**
 * The walk-in queue.
 *
 * Seating returns a HOLD, not a booking. The desk confirms it through the
 * ordinary POST /v1/bookings, because a walk-in confirmed on its own path is a
 * walk-in whose deposit rules and audit trail drift from everybody else's.
 *
 * @DeskOnly, AND THE WHOLE CONTROLLER, not just the join.
 *
 * A walk-in is somebody standing in front of the desk being written down by
 * whoever is behind it. There is no remote walk-in: a customer who wants a
 * slot from their phone wants POST /v1/holds, which exists, prices properly
 * and holds a real slot. Letting them queue instead would put a name in the
 * waiting room that nobody can call.
 *
 * The other three are refused for a blunter reason. The queue lists everyone
 * waiting BY NAME, seating puts a stranger in a chair, and leaving removes
 * one -- all of them by id, none of them the caller's own. Those were 200 to
 * any customer token before this decorator.
 */
@ApiTags('walk-ins')
@Controller('walk-ins')
@DeskOnly()
export class WalkInsController {
  constructor(private readonly handler: WalkInHandler) {}

  @Post()
  @ApiOperation({ summary: 'Add somebody to the queue' })
  @ApiCreatedResponse({ description: 'Their place in the queue.' })
  async join(@Body() dto: JoinWalkInDto): Promise<{
    id: string;
    position: number;
    serviceIds: readonly string[];
  }> {
    return this.handler.join({
      branchId: dto.branchId,
      tradingDay: dto.tradingDay,
      customerId: dto.customerId ?? null,
      guestName: dto.guestName ?? null,
      serviceIds: dto.serviceIds,
      joinedMin: dto.joinedMin,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'The queue, with a live quote of the nearest options',
    description:
      'Each row shows who is waiting, what they want, how long they have ' +
      'been there, and the nearest starts the engine can actually offer.',
  })
  @ApiOkResponse({ description: 'The queue in arrival order.' })
  async view(
    @Query('branchId') branchId: string,
    @Query('tradingDay') tradingDay: string,
    @Query('nowMin') nowMin: string,
  ): Promise<WalkInQueueView> {
    return this.handler.view(branchId, tradingDay, Number(nowMin));
  }

  @Post(':id/seat')
  @ApiOperation({
    summary: 'Seat a walk-in',
    description:
      'Places an ordinary hold on the chosen start. Confirm it through ' +
      'POST /v1/bookings exactly as any other booking.',
  })
  @ApiOkResponse({ description: 'The hold to confirm.' })
  @ApiNotFoundResponse()
  async seat(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: SeatWalkInDto,
  ): Promise<unknown> {
    return this.handler.seat(id, dto.startMin, dto.staffId);
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'They gave up, or were sent to the waitlist' })
  async leave(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<{ left: boolean }> {
    return this.handler.leave(id);
  }
}
