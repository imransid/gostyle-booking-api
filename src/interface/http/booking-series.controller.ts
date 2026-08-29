import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  SeriesPreviewHandler,
  type SeriesPreviewView,
} from '@application/queries/series-preview.handler';
import {
  SeriesPanelHandler,
  type SeriesPanelView,
} from '@application/commands/series.handler';
import { ResourceIdPipe } from './resource-id.pipe';
import { PatternDto, EndDto, toPattern, toEnd } from './series.controller';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { SERIES_HORIZON_DAYS } from '@domain/booking/recurrence';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class SeriesPreviewDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branchId: string = 'marina-walk';

  @ApiProperty({ example: 'dana' })
  @IsString()
  customerId!: string;

  @ApiProperty({ example: 'blow-dry' })
  @IsString()
  serviceId!: string;

  @ApiPropertyOptional({ example: 'maya', description: 'Omit for anyone.' })
  @IsOptional()
  @IsString()
  preferredStaffId?: string;

  @ApiProperty({ example: '2026-10-06' })
  @Matches(DAY, { message: 'anchorDay must be YYYY-MM-DD' })
  anchorDay!: string;

  @ApiProperty({ example: 1080 })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  startMin!: number;

  @ApiProperty({ type: PatternDto })
  @ValidateNested()
  @Type(() => PatternDto)
  pattern!: PatternDto;

  @ApiProperty({ type: EndDto })
  @ValidateNested()
  @Type(() => EndDto)
  end!: EndDto;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Preview from this day. Defaults to the anchor.',
  })
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: SERIES_HORIZON_DAYS,
    default: SERIES_HORIZON_DAYS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  horizonDays?: number;
}

/**
 * The series surface the front-end contract puts under /v1/bookings.
 *
 * `preview` is declared before `:id` and this controller is registered ahead
 * of the parameterised ones, which is the rule route-order.spec.ts enforces.
 * Here the two do not actually collide — preview is a POST and the panel a
 * GET — but relying on that is relying on nobody ever adding GET preview.
 */
@ApiTags('series')
@Controller('bookings/series')
export class BookingSeriesController {
  constructor(
    private readonly preview: SeriesPreviewHandler,
    private readonly series: SeriesPanelHandler,
  ) {}

  @Post('preview')
  @ApiOperation({
    summary: 'Dry-run every occurrence a series would create',
    description:
      'Answers "if I commit to Tuesdays at six, what actually happens?" ' +
      'while the answer can still change the plan. Each occurrence comes ' +
      'back EXACT, REPAIRABLE, NEEDS_ATTENTION, DEFERRED or CLOSED, with the ' +
      'reason and any alternatives. Writes nothing.',
  })
  @ApiOkResponse({ description: 'Every occurrence and its verdict.' })
  previewSeries(@Body() dto: SeriesPreviewDto): Promise<SeriesPreviewView> {
    return this.preview.execute({
      branchId: dto.branchId,
      customerId: dto.customerId,
      serviceId: dto.serviceId,
      preferredStaffId: dto.preferredStaffId ?? null,
      anchorDay: dto.anchorDay,
      startMin: dto.startMin,
      pattern: toPattern(dto.pattern),
      end: toEnd(dto.end),
      from: dto.from ?? dto.anchorDay,
      ...(dto.horizonDays !== undefined
        ? { horizonDays: dto.horizonDays }
        : {}),
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'The series panel',
    description:
      'Status, health and its reasons, the horizon line, the occurrence ' +
      'timeline, and the course meter when there is one.',
  })
  @ApiOkResponse({ description: 'The panel.' })
  @ApiNotFoundResponse({ description: 'No such series.' })
  panel(@Param('id', ResourceIdPipe) id: string): Promise<SeriesPanelView> {
    return this.series.execute(id);
  }
}
