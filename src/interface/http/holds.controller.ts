import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { BranchId } from './branch.decorator';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ArrayNotEmpty,
  IsArray,
} from 'class-validator';
import {
  PlaceHoldHandler,
  type HoldView,
} from '@application/commands/place-hold.handler';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

export class PlaceHoldDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description:
      'OPTIONAL. The branch comes from the token when the token names one; ' +
      'send this only for a token scoped to no particular branch. A branch ' +
      'the token does not cover is 403 BOOKING_BRANCH_MISMATCH \u2014 it used to ' +
      'be accepted, and the write then landed somewhere the reads could not ' +
      'see. Spelled `branch` here rather than `branchId` because this route ' +
      'shipped before the wire contract and existing callers send `branch`.',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiProperty({ example: '2026-08-24' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({ example: ['full-colour'], type: [String] })
  @IsArray()
  @ArrayNotEmpty({ message: 'pick at least one service' })
  @IsString({ each: true })
  services!: string[];

  @ApiProperty({
    example: 1105,
    description: 'Minutes from midnight. 1105 is 18:25.',
  })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  startMin!: number;

  @ApiPropertyOptional({
    example: 'maya',
    description: 'Omit for any available.',
  })
  @IsOptional()
  @IsString()
  staffId?: string;

  @ApiPropertyOptional({ example: null })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ enum: ['desk', 'online'], default: 'desk' })
  @IsOptional()
  @IsIn(['desk', 'online'])
  channel: 'desk' | 'online' = 'desk';
}

@ApiTags('holds')
/**
 * TWO PATHS, ONE CONTROLLER.
 *
 * The front-end contract mounts everything under /v1/bookings/*; this
 * service mounted by aggregate. Nest takes an array of controller paths, so
 * both spellings reach the SAME handlers -- no second controller, no
 * forwarding, nothing to drift. The aggregate path stays because existing
 * clients use it.
 */
@Controller(['holds', 'bookings/holds'])
export class HoldsController {
  constructor(private readonly handler: PlaceHoldHandler) {}

  @Post()
  @ApiOperation({
    summary: 'Reserve a slot while the customer pays',
    description:
      'Re-runs the engine on fresh data, then writes the reservation rows ' +
      'inside one transaction. Staff time is protected by an exclusion ' +
      'constraint; chair capacity by an advisory lock and a recount. ' +
      'A dead hold protects nothing, so the TTL is the real deadline.',
  })
  @ApiCreatedResponse({ description: 'Held. The countdown has started.' })
  @ApiConflictResponse({
    description: 'The slot went while you were deciding, or no chair is free.',
  })
  place(
    @Body() dto: PlaceHoldDto,
    @CurrentActor() actor: Actor,
    @BranchId('branch') branchId: string,
  ): Promise<HoldView> {
    return this.handler.execute({
      branchId,
      tradingDay: dto.day,
      serviceIds: dto.services,
      startMin: dto.startMin,
      preferredStaffId: dto.staffId ?? null,
      customerId:
        actor.kind === 'customer' ? actor.id : (dto.customerId ?? null),
      channel: dto.channel,
    });
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give the slot back',
    description:
      'The reservations cascade away with the hold, so capacity returns in ' +
      'the same statement rather than in a later cleanup.',
  })
  @ApiOkResponse({ schema: { example: { released: true } } })
  release(@Param('id') id: string): Promise<{ released: boolean }> {
    return this.handler.release(id);
  }
}
