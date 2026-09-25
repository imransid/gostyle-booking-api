import { Body, Controller, Post } from '@nestjs/common';
import { BranchId } from './branch.decorator';
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
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import {
  GroupAvailabilityHandler,
  type GroupAvailabilityManyView,
  type GroupAvailabilityView,
} from '@application/queries/group-availability.handler';
import {
  modeFromWire,
  WIRE_GROUP_MODES,
  type WireGroupMode,
} from '@application/contract/wire';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { MAX_PARTY_STARTS } from '@domain/availability/party-starts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One start or a list of them, never both.
 *
 * A body with both is ambiguous about which answer it wants back -- one view
 * or a list of them -- and picking either silently would hand some caller
 * the shape it did not parse. So it is a 400 that says so.
 */
function WithoutTargetMin(): PropertyDecorator {
  return ValidateBy({
    name: 'withoutTargetMin',
    validator: {
      validate: (_value: unknown, args?: ValidationArguments): boolean =>
        (args?.object as { targetMin?: unknown } | undefined)?.targetMin ===
        undefined,
      defaultMessage: (): string => 'send targetMin or targetMins, not both',
    },
  });
}

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

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DAY, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: 1080,
    required: false,
    description:
      'Minutes from midnight. Required unless targetMins is sent; never both.',
  })
  // True for every body that has ever worked here -- targetMins did not
  // exist, so none carried it -- which runs the three rules below exactly as
  // they always ran. Skipped only when the caller asks about a list instead.
  @ValidateIf((o: GroupAvailabilityDto) => o.targetMins === undefined)
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  targetMin!: number;

  @ApiPropertyOptional({
    type: [Number],
    example: [600, 630, 660],
    minItems: 1,
    maxItems: MAX_PARTY_STARTS,
    description:
      'Several starts in one call, instead of targetMin. Each is minutes ' +
      'from midnight under the same rule as targetMin. The day, the roster ' +
      'and the services are loaded ONCE and the party is planned at each ' +
      'start against that one picture of the day. The answer is ' +
      '{ starts: [...] }: one entry per start, in the order asked, each ' +
      `exactly what targetMin alone would have answered. At most ` +
      `${MAX_PARTY_STARTS} -- the whole day at half-hour steps.`,
  })
  @ValidateIf((o: GroupAvailabilityDto) => o.targetMins !== undefined)
  @WithoutTargetMin()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PARTY_STARTS)
  @IsInt({ each: true })
  @Min(DAY_START_MIN, { each: true })
  @Max(DAY_END_MIN - 1, { each: true })
  targetMins?: number[];

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
      'before you do. Send targetMins instead of targetMin to ask about ' +
      'several starts at once.',
  })
  @ApiOkResponse({
    description:
      'The lane plan, or the reason there is none. With targetMins: ' +
      '{ starts: [...] }, one such answer per start, in the order asked.',
  })
  @ApiConflictResponse({ description: 'The branch is closed that day.' })
  group(
    @Body() dto: GroupAvailabilityDto,
    @BranchId() branchId: string,
  ): Promise<GroupAvailabilityView | GroupAvailabilityManyView> {
    // MANY STARTS, ONE LOAD. Only a body that says targetMins comes this way,
    // and no body that worked before this existed could say it: the pipe
    // refused the key as unknown. Every other body falls through to the
    // single call below, which is exactly the call it has always made.
    if (dto.targetMins !== undefined) {
      return this.handler.executeMany({
        branchId,
        tradingDay: dto.day,
        targetMins: dto.targetMins,
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

    return this.handler.execute({
      branchId,
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
