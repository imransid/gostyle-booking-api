import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ResourceIdPipe } from './resource-id.pipe';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
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
  CreateSeriesHandler,
  SeriesLifecycleHandler,
  SeriesPanelHandler,
  type LifecycleResult,
  type SeriesPanelView,
  type SeriesView,
} from '@application/commands/series.handler';
import {
  MaterialiseSeriesHandler,
  type MaterialiseResult,
} from '@application/commands/materialise-series.handler';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import type { EditScope } from '@domain/booking/series-edit';
import type {
  EndCondition,
  Pattern,
  Weekday,
} from '@domain/booking/recurrence';

import { shout, unshout } from '@application/contract/wire';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The domain words the shouted request enum folds back down to. */
const AUTO_CONFIRM_RULES = [
  'auto_confirm_on_schedule',
  'ask_each_time',
  'vip_standing',
] as const;

export class PatternDto {
  @ApiProperty({
    enum: ['WEEKLY', 'EVERY_N_WEEKS', 'MONTHLY_ON_DATE', 'CUSTOM'],
  })
  @WireEnum(['WEEKLY', 'EVERY_N_WEEKS', 'MONTHLY_ON_DATE', 'CUSTOM'])
  kind!: 'WEEKLY' | 'EVERY_N_WEEKS' | 'MONTHLY_ON_DATE' | 'CUSTOM';

  @ApiPropertyOptional({
    example: [2, 4],
    description: '0 is Sunday, 6 is Saturday.',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays?: number[];

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  weeks?: number;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @ApiPropertyOptional({ example: ['2026-09-04', '2026-09-20'] })
  @IsOptional()
  @IsArray()
  @Matches(DAY, { each: true })
  dates?: string[];
}

export class EndDto {
  @ApiProperty({ enum: ['NEVER', 'ON_DATE', 'AFTER_COUNT'] })
  @WireEnum(['NEVER', 'ON_DATE', 'AFTER_COUNT'])
  kind!: 'NEVER' | 'ON_DATE' | 'AFTER_COUNT';

  @ApiPropertyOptional({ example: '2027-03-01' })
  @IsOptional()
  @Matches(DAY)
  date?: string;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  count?: number;
}

export class CourseDto {
  @ApiProperty({ example: 180000, description: 'Net of VAT, in fils.' })
  @IsInt()
  @Min(0)
  totalNetMinor!: number;

  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(1)
  visits!: number;
}

export class CreateSeriesDto {
  @ApiProperty()
  @IsString()
  branchId!: string;

  @ApiProperty()
  @IsString()
  customerId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DAY)
  anchorDay!: string;

  @ApiProperty({ example: 1080, description: '1080 is 18:00.' })
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

  @ApiProperty({
    enum: ['AUTO_CONFIRM_ON_SCHEDULE', 'ASK_EACH_TIME', 'VIP_STANDING'],
  })
  @WireEnum(['AUTO_CONFIRM_ON_SCHEDULE', 'ASK_EACH_TIME', 'VIP_STANDING'])
  autoConfirmRule!:
    'AUTO_CONFIRM_ON_SCHEDULE' | 'ASK_EACH_TIME' | 'VIP_STANDING';

  @ApiProperty({ example: 'blow-dry' })
  @IsString()
  serviceId!: string;

  @ApiPropertyOptional({ example: 'maya' })
  @IsOptional()
  @IsString()
  preferredStaffId?: string;

  @ApiPropertyOptional({ type: CourseDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CourseDto)
  course?: CourseDto;
}

export class MaterialiseDto {
  @ApiProperty({ example: '2026-09-01', description: "The branch's today." })
  @Matches(DAY)
  today!: string;
}

/**
 * The series surface.
 *
 * Everything here is a thin translation. The decisions live in the domain and
 * the handlers; a controller that started deciding would be a second place to
 * look when the answer is wrong.
 */
@ApiTags('series')
@Controller('series')
export class SeriesController {
  constructor(
    private readonly create: CreateSeriesHandler,
    private readonly panel: SeriesPanelHandler,
    private readonly lifecycle: SeriesLifecycleHandler,
    private readonly materialiser: MaterialiseSeriesHandler,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a recurring series',
    description:
      'Expands the pattern to the 70-day horizon and stores the wanted ' +
      'occurrences. Nothing is booked until materialisation runs.',
  })
  @ApiCreatedResponse({ description: 'The series and its first occurrences.' })
  @ApiUnprocessableEntityResponse({
    description:
      'The pattern produces no visits, or the tier cannot hold a standing reservation.',
  })
  async createSeries(@Body() dto: CreateSeriesDto): Promise<SeriesView> {
    return this.create.execute({
      branchId: dto.branchId,
      customerId: dto.customerId,
      anchorDay: dto.anchorDay,
      startMin: dto.startMin,
      pattern: toPattern(dto.pattern),
      end: toEnd(dto.end),
      autoConfirmRule: unshout(dto.autoConfirmRule, AUTO_CONFIRM_RULES)!,
      serviceId: dto.serviceId,
      preferredStaffId: dto.preferredStaffId ?? null,
      course:
        dto.course === undefined
          ? null
          : {
              totalNetFils: dto.course.totalNetMinor,
              visits: dto.course.visits,
            },
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'The series panel: timeline, health and course meter',
  })
  @ApiOkResponse({ description: 'The occurrence timeline with health.' })
  @ApiNotFoundResponse()
  async getPanel(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<SeriesPanelView> {
    return this.panel.execute(id);
  }

  @Get(':id/occurrences')
  @ApiOperation({ summary: 'The occurrence timeline alone' })
  async getOccurrences(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<SeriesPanelView['occurrences']> {
    return (await this.panel.execute(id)).occurrences;
  }

  @Post(':id/materialise')
  @ApiOperation({
    summary: 'Run the occurrences through the availability engine',
    description:
      'Tops the calendar up to the horizon, then seats every planned ' +
      'occurrence inside the 90-day booking horizon. The repair ladder runs ' +
      'on anything that no longer fits.',
  })
  async materialise(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: MaterialiseDto,
  ): Promise<MaterialiseResult> {
    return this.materialiser.run(id, dto.today);
  }

  @Post(':id/pause')
  @ApiOperation({
    summary: 'Pause the series',
    description:
      'Cancels unstarted future occurrences beyond the 48-hour protection ' +
      'window. Anything inside it is returned for the desk to confirm one at a time.',
  })
  async pause(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<LifecycleResult> {
    return this.lifecycle.pauseOrEnd(id, 'paused');
  }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Resume a paused series' })
  async resume(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<LifecycleResult> {
    return this.lifecycle.resume(id);
  }

  @Post(':id/end')
  @ApiOperation({ summary: 'End the series for good' })
  async end(@Param('id', ResourceIdPipe) id: string): Promise<LifecycleResult> {
    return this.lifecycle.pauseOrEnd(id, 'ended');
  }

  @Post(':id/occurrences/:occurrenceId/skip')
  @ApiOperation({
    summary: 'Skip one occurrence',
    description: 'The slot is released and the series continues.',
  })
  async skip(
    @Param('id', ResourceIdPipe) id: string,
    @Param('occurrenceId', ResourceIdPipe) occurrenceId: string,
  ): Promise<LifecycleResult> {
    return this.lifecycle.skip(id, occurrenceId);
  }

  @Get(':id/occurrences/:occurrenceId/edit-scope')
  @ApiOperation({
    summary: 'What would an edit at this scope touch?',
    description:
      'Editing asks for scope every time. This is the preview the desk sees ' +
      'before choosing, so nobody rewrites a year of visits by accident.',
  })
  async previewEdit(
    @Param('id', ResourceIdPipe) id: string,
    @Param('occurrenceId', ResourceIdPipe) occurrenceId: string,
    @Query('scope') scope: string,
  ): Promise<{
    affected: readonly string[];
    detached: readonly string[];
    untouched: readonly string[];
    ineligible: readonly string[];
    explanation: string;
  }> {
    // Shouted on the wire like every other request enum, folded back to the
    // domain's own spelling by the one function that does that. Hand-rolling
    // the comparison here is what let this one stay lowercase after e856885
    // shouted the rest -- the vocabulary guard only reads @IsIn/@WireEnum,
    // and a `find` in a method body is invisible to it.
    const legal: EditScope[] = [
      'this_occurrence',
      'this_and_future',
      'entire_series',
    ];
    // `scope` is a raw @Query, so the ValidationPipe never sees it and an
    // omitted one arrives as undefined. unshout() then called .toLowerCase()
    // on it and the caller got `500 Internal server error` for the ordinary
    // mistake of leaving a parameter off -- the answer they needed is the
    // 422 three lines below, which already lists the legal values.
    const chosen = typeof scope === 'string' ? unshout(scope, legal) : null;
    if (chosen === null) {
      throw new UnprocessableEntityException(
        `scope must be one of: ${legal.map(shout).join(', ')}`,
      );
    }
    return this.lifecycle.previewEdit(id, occurrenceId, chosen);
  }
}

export function toPattern(dto: PatternDto): Pattern {
  switch (dto.kind) {
    case 'WEEKLY':
      return { kind: 'weekly', weekdays: (dto.weekdays ?? []) as Weekday[] };
    case 'EVERY_N_WEEKS':
      return { kind: 'every_n_weeks', weeks: dto.weeks ?? 1 };
    case 'MONTHLY_ON_DATE':
      return { kind: 'monthly_on_date', dayOfMonth: dto.dayOfMonth ?? 1 };
    case 'CUSTOM':
      return { kind: 'custom', dates: dto.dates ?? [] };
  }
}

export function toEnd(dto: EndDto): EndCondition {
  switch (dto.kind) {
    case 'NEVER':
      return { kind: 'never' };
    case 'ON_DATE':
      return { kind: 'on_date', date: dto.date ?? '' };
    case 'AFTER_COUNT':
      return { kind: 'after_count', count: dto.count ?? 1 };
  }
}
