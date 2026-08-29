import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import {
  GroupAvailabilityHandler,
  type GroupAvailabilityView,
} from '@application/queries/group-availability.handler';
import {
  modeFromWire,
  WIRE_GROUP_MODES,
  type WireGroupMode,
} from '@application/contract/wire';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class GroupAvailabilityParticipantDto {
  @ApiProperty({ example: 'Reem' })
  @IsString()
  label!: string;

  @ApiProperty({ example: ['blow-dry'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  serviceIds!: string[];

  @ApiPropertyOptional({ example: 'maya', description: 'Omit for anyone.' })
  @IsOptional()
  @IsString()
  preferredStaffId?: string;
}

export class GroupAvailabilityDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branchId: string = 'marina-walk';

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DAY, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({ example: 1080, description: 'Minutes from midnight.' })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  targetMin!: number;

  @ApiProperty({ enum: WIRE_GROUP_MODES })
  @WireEnum(WIRE_GROUP_MODES)
  mode!: WireGroupMode;

  @ApiPropertyOptional({ example: 15, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  finishWindowMin?: number;

  @ApiPropertyOptional({ example: 45 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxStaggerMin?: number;

  @ApiProperty({
    type: [GroupAvailabilityParticipantDto],
    minItems: 2,
    maxItems: 8,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => GroupAvailabilityParticipantDto)
  participants!: GroupAvailabilityParticipantDto[];
}

/**
 * Can this party be seated? Without taking the slot to find out.
 */
@ApiTags('availability')
@Controller('bookings/availability')
export class GroupAvailabilityController {
  constructor(private readonly handler: GroupAvailabilityHandler) {}

  @Post('group')
  @ApiOperation({
    summary: 'Plan a party without holding it',
    description:
      'Runs the same planner the group hold runs, on the same context, and ' +
      'writes nothing. Advisory: another desk may take one of these lanes ' +
      'before you do.',
  })
  @ApiOkResponse({ description: 'The lane plan, or the reason there is none.' })
  @ApiConflictResponse({ description: 'The branch is closed that day.' })
  group(@Body() dto: GroupAvailabilityDto): Promise<GroupAvailabilityView> {
    return this.handler.execute({
      branchId: dto.branchId,
      tradingDay: dto.day,
      targetMin: dto.targetMin,
      mode: modeFromWire(dto.mode),
      ...(dto.finishWindowMin !== undefined
        ? { finishWindowMin: dto.finishWindowMin }
        : {}),
      ...(dto.maxStaggerMin !== undefined
        ? { maxStaggerMin: dto.maxStaggerMin }
        : {}),
      participants: dto.participants.map((p) => ({
        label: p.label,
        serviceIds: p.serviceIds,
        preferredStaffId: p.preferredStaffId ?? null,
      })),
    });
  }
}
