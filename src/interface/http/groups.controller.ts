import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
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
  ValidateNested,
} from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import { Type } from 'class-transformer';
import {
  GroupHoldHandler,
  type GroupHoldView,
} from '@application/commands/group-hold.handler';
import {
  GroupConfirmHandler,
  type GroupConfirmView,
} from '@application/commands/group-confirm.handler';
import { ApiGoneResponse, ApiNotFoundResponse } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { Param } from '@nestjs/common';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import {
  WIRE_GROUP_MODES,
  WIRE_ARRANGEMENTS,
  modeFromWire,
  arrangementFromWire,
  type WireGroupMode,
  type WireArrangement,
} from '@application/contract/wire';

export class ParticipantDto {
  @ApiProperty({ example: 'Dana' })
  @IsString()
  label!: string;

  @ApiProperty({ example: ['full-colour'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  serviceIds!: string[];

  @ApiPropertyOptional({
    description:
      'A registered customer. Leave out for a named guest under the organiser.',
  })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'A named guest. Exactly one of customerId or guestName.',
  })
  @IsOptional()
  @IsString()
  guestName?: string;

  @ApiPropertyOptional({ example: 'maya' })
  @IsOptional()
  @IsString()
  preferredStaffId?: string;
}

export class GroupHoldDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;

  @ApiPropertyOptional({
    example: 15,
    default: 0,
    description:
      'How many minutes apart the party may FINISH and still count as ' +
      'finishing together. Zero, the default, means exactly together. Slack ' +
      'buys feasibility: a lane allowed to end early can start early, which ' +
      'may be the only place its professional is free. Nothing ever runs ' +
      'past the anchor, so nobody waits longer. Ignored for TOGETHER.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  finishWindowMin?: number;

  @ApiPropertyOptional({
    example: 45,
    description:
      'The widest gap allowed between the first and last arrival. Finishing ' +
      'together staggers arrivals by the difference between the longest and ' +
      'shortest service; this caps it. Omitted means the whole trading day, ' +
      'which is no practical cap.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxStaggerMin?: number;

  @ApiProperty({ example: '2027-08-09' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: 600,
    description:
      'The anchor. In arrive-together every lane starts here; in ' +
      'finish-together the lanes stagger backwards to END together.',
  })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  targetMin!: number;

  @ApiProperty({
    enum: WIRE_GROUP_MODES,
    description:
      'TOGETHER seats everyone at targetMin. FINISH staggers the starts ' +
      'backwards so the party leaves as one.',
  })
  @WireEnum(WIRE_GROUP_MODES)
  mode!: WireGroupMode;

  @ApiProperty({
    enum: WIRE_ARRANGEMENTS,
    description:
      'ORGANIZER charges the whole party to whoever booked it. SPLIT divides ' +
      'it evenly, remainder first. OWN charges each participant their own.',
  })
  @WireEnum(WIRE_ARRANGEMENTS)
  arrangement!: WireArrangement;

  @ApiProperty({ type: [ParticipantDto], minItems: 2, maxItems: 8 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants!: ParticipantDto[];
}

export class GroupConfirmDto {
  @ApiProperty({
    description: 'The party hold returned by POST /groups/holds.',
  })
  @IsUUID()
  holdId!: string;

  @ApiProperty({ type: [ParticipantDto], minItems: 2, maxItems: 8 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants!: ParticipantDto[];
}

@ApiTags('groups')
@Controller('groups')
export class GroupsController {
  constructor(
    private readonly handler: GroupHoldHandler,
    private readonly confirms: GroupConfirmHandler,
  ) {}

  @Post('holds')
  @ApiOperation({
    summary: 'Hold every lane of a party, or none of them',
    description:
      'One hold covers the whole party. If any lane loses a race the others ' +
      'go with it, because they were never committed: there is no partial ' +
      'party to clean up. A half-held group is worse than no group.',
  })
  @ApiCreatedResponse({ description: 'Held, with one lane per participant.' })
  @ApiConflictResponse({
    description: 'The party does not fit. The reason names the remedy.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fewer than two, more than eight, or an unknown service.',
  })
  hold(
    @Body() dto: GroupHoldDto,
    @CurrentActor() actor: Actor,
  ): Promise<GroupHoldView> {
    return this.handler.execute({
      branchId: dto.branchId,
      organiserId: actor.id ?? 'anonymous',
      tradingDay: dto.day,
      targetMin: dto.targetMin,
      mode: modeFromWire(dto.mode),
      ...(dto.finishWindowMin !== undefined
        ? { finishWindowMin: dto.finishWindowMin }
        : {}),
      ...(dto.maxStaggerMin !== undefined
        ? { maxStaggerMin: dto.maxStaggerMin }
        : {}),
      arrangement: arrangementFromWire(dto.arrangement),
      participants: dto.participants.map((p) => ({
        label: p.label,
        serviceIds: p.serviceIds,
        customerId: p.customerId ?? null,
        guestName: p.guestName ?? (p.customerId === undefined ? p.label : null),
        preferredStaffId: p.preferredStaffId ?? null,
      })),
    });
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary: 'Turn a held party into one booking per participant',
    description:
      'THE PLAN IS RE-RUN on fresh masks. The hold protected these lanes ten ' +
      'minutes ago; this asks again whether the party still works. If it no ' +
      'longer does, nothing is written and nothing is charged.',
  })
  @ApiCreatedResponse({
    description: 'Confirmed, one booking per participant.',
  })
  @ApiGoneResponse({ description: 'The party hold expired.' })
  @ApiConflictResponse({
    description: 'The party no longer fits, or the group is not a draft.',
  })
  @ApiNotFoundResponse({ description: 'No such group.' })
  confirm(
    @Param('id') id: string,
    @Body() dto: GroupConfirmDto,
    @CurrentActor() actor: Actor,
  ): Promise<GroupConfirmView> {
    return this.confirms.execute({
      groupId: id,
      holdId: dto.holdId,
      participants: dto.participants.map((p) => ({
        label: p.label,
        serviceIds: p.serviceIds,
        preferredStaffId: p.preferredStaffId ?? null,
      })),
      actorId: actor.id,
    });
  }
}
