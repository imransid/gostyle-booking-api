import { Public } from '../../auth/public.decorator';
import { BranchId } from './branch.decorator';
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

  @ApiProperty({
    example: '2026-08-24',
    description:
      'Trading day, YYYY-MM-DD, in the branch timezone (Asia/Dhaka).',
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
}

@ApiTags('availability')
/**
 * TWO PATHS, ONE CONTROLLER.
 *
 * The front-end contract mounts everything under /v1/bookings/*; this
 * service mounted by aggregate. Nest takes an array of controller paths, so
 * both spellings reach the SAME handlers -- no second controller, no
 * forwarding, nothing to drift. The aggregate path stays because existing
 * clients use it.
 */
@Controller(['availability', 'bookings/availability'])
@Public()
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
  get(
    @Query() q: AvailabilityQueryDto,
    @BranchId('branch') branchId: string,
  ): Promise<AvailabilityView> {
    return this.availability.execute({
      branchId,
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
  list(
    @Query() _q: CatalogueQueryDto,
    @BranchId('branch') branchId: string,
  ): Promise<CatalogueItemView[]> {
    return this.catalogue.execute(branchId);
  }
}
