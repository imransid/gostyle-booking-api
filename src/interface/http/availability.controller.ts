import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ArrayNotEmpty,
} from 'class-validator';
import {
  GetAvailabilityHandler,
  GetCatalogueHandler,
  type AvailabilityView,
  type CatalogueItemView,
} from '@application/queries/get-availability.handler';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import {
  AvailabilityResponseDto,
  ServiceSummaryDto,
} from './availability.response';

export class AvailabilityQueryDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsString()
  branch = 'marina-walk';

  @ApiProperty({
    example: '2026-08-24',
    description:
      'Trading day, YYYY-MM-DD, in the branch timezone (Asia/Dubai).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: 'full-colour',
    description:
      'Comma separated service ids, in the order the operator picked them. ' +
      'Call GET /availability/catalogue for the list.',
  })
  @Transform(({ value }: { value: unknown }): string[] =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  )
  @IsArray()
  @ArrayNotEmpty({ message: 'pick at least one service' })
  @IsString({ each: true })
  services!: string[];

  @ApiPropertyOptional({
    enum: ['desk', 'online'],
    default: 'desk',
    description:
      'Desk offers a 5-minute grain with 15 minutes lead. Online is 15 and 60.',
  })
  @IsOptional()
  @IsIn(['desk', 'online'])
  channel: 'desk' | 'online' = 'desk';

  @ApiPropertyOptional({
    example: 'any',
    description:
      'A professional id, or "any" to let the engine offer everyone eligible.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): string | null =>
    typeof value === 'string' && value !== 'any' && value !== '' ? value : null,
  )
  @IsString()
  staff: string | null = null;

  @ApiPropertyOptional({
    example: 600,
    minimum: DAY_START_MIN,
    maximum: DAY_END_MIN,
    description: 'Window start in minutes from midnight. 840 is 14:00.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): number => Number(value))
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  from: number = DAY_START_MIN;

  @ApiPropertyOptional({
    example: 1320,
    minimum: DAY_START_MIN,
    maximum: DAY_END_MIN,
    description: 'Window end in minutes from midnight. 1020 is 17:00.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): number => Number(value))
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  to: number = DAY_END_MIN;

  @ApiPropertyOptional({
    example: 825,
    description:
      'Testing only. Pretend the branch clock reads this minute of day, so the ' +
      'lead-time rule can be exercised without waiting.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): number => Number(value))
  @IsInt()
  now?: number;
}

export class CatalogueQueryDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branch = 'marina-walk';
}

@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(
    private readonly availability: GetAvailabilityHandler,
    private readonly catalogue: GetCatalogueHandler,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Which start times can this salon actually deliver',
    description:
      'Intersects four masks: who is free (buffers respected), whether a chair ' +
      'exists for every segment of the chain, and what the channel is willing to ' +
      'offer (grain, lead time, window, closing time). Returns every feasible ' +
      'start, plus who could take each one, plus why anyone was refused.',
  })
  @ApiOkResponse({ type: AvailabilityResponseDto })
  @ApiBadRequestResponse({
    description: 'A query parameter failed validation.',
  })
  @ApiNotFoundResponse({
    description: 'One of the service ids does not exist.',
  })
  get(@Query() q: AvailabilityQueryDto): Promise<AvailabilityView> {
    return this.availability.execute({
      branchId: q.branch,
      tradingDay: q.day,
      serviceIds: q.services,
      channel: q.channel,
      preferredStaffId: q.staff,
      fromMin: q.from,
      toMin: q.to,
      ...(q.now !== undefined ? { nowOverrideMin: q.now } : {}),
    });
  }

  @Get('catalogue')
  @ApiOperation({
    summary: 'Every bookable service and its id',
    description: 'Start here. Copy an id into the services parameter above.',
  })
  @ApiOkResponse({ type: [ServiceSummaryDto] })
  list(@Query() q: CatalogueQueryDto): Promise<CatalogueItemView[]> {
    return this.catalogue.execute(q.branch);
  }
}
