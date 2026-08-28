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
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  GroupHoldHandler,
  type GroupHoldView,
} from '@application/commands/group-hold.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import type { GroupMode } from '@domain/availability/party';

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

  @ApiProperty({ enum: ['arrive_together', 'finish_together'] })
  @IsIn(['arrive_together', 'finish_together'])
  mode!: GroupMode;

  @ApiProperty({
    enum: ['organiser_pays_all', 'split_equally', 'each_pays_own'],
  })
  @IsIn(['organiser_pays_all', 'split_equally', 'each_pays_own'])
  arrangement!: 'organiser_pays_all' | 'split_equally' | 'each_pays_own';

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
  constructor(private readonly handler: GroupHoldHandler) {}

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
      mode: dto.mode,
      arrangement: dto.arrangement,
      participants: dto.participants.map((p) => ({
        label: p.label,
        serviceIds: p.serviceIds,
        customerId: p.customerId ?? null,
        guestName: p.guestName ?? (p.customerId === undefined ? p.label : null),
        preferredStaffId: p.preferredStaffId ?? null,
      })),
    });
  }
}
