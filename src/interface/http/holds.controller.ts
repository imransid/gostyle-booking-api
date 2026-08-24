import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
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

export class PlaceHoldDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branch = 'marina-walk';

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
@Controller('holds')
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
  place(@Body() dto: PlaceHoldDto): Promise<HoldView> {
    return this.handler.execute({
      branchId: dto.branch,
      tradingDay: dto.day,
      serviceIds: dto.services,
      startMin: dto.startMin,
      preferredStaffId: dto.staffId ?? null,
      customerId: dto.customerId ?? null,
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
