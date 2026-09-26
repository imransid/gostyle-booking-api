import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
  UsePipes,
  Optional,
  Patch,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import {
  MobileSeriesHandler,
  type MobileSeriesPreview,
} from '@application/commands/mobile-series.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
} from '@application/queries/mobile-series-read.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { mobileValidationPipe } from './mobile-validation.pipe';
import { MobileProductLineDto } from './mobile-booking.controller';
import {
  MobileSeriesEnabledGuard,
  seriesDepositPercent,
} from './mobile-series.flag';
import { MobileSeriesManageHandler } from '@application/commands/mobile-series-manage.handler';
import { manageClaimFrom } from '@domain/booking/mobile-series-manage';
import { MobileContractError } from '@application/commands/mobile-booking.error';

/** One service of a session. `amount` is echoed by the app, never trusted. */
export class RoutineServiceDto {
  @ApiProperty({ example: 'haircut-finish' })
  @IsString()
  id!: string;

  @ApiPropertyOptional({ example: 120, description: 'Decimal AED. Not used.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;
}

/** D4: the alternative the customer chose for one session. */
export class RoutinePickDto {
  @ApiProperty({ example: 2, description: 'The session number, from 0.' })
  @IsInt()
  index!: number;

  @ApiProperty({ example: '2026-10-21' })
  @IsString()
  date!: string;

  @ApiProperty({ example: '16:30' })
  @IsString()
  time!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Left out keeps the routine stylist.',
  })
  @IsOptional()
  @IsString()
  stylist_id?: string | null;
}

export class MobileSeriesDto {
  @ApiPropertyOptional({
    default: false,
    description: 'true: preview only, nothing is saved.',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;

  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  salon_id!: string;

  @ApiProperty({ type: [RoutineServiceDto], description: 'D1: one or more.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutineServiceDto)
  services!: RoutineServiceDto[];

  @ApiPropertyOptional({ example: 'maya', description: 'The regular stylist.' })
  @IsOptional()
  @IsString()
  stylist_id?: string | null;

  @ApiProperty({
    enum: ['DAILY', 'WEEKLY', 'EVERY_2_WEEKS', 'MONTHLY', 'CUSTOM'],
  })
  @IsString()
  frequency!: string;

  @ApiPropertyOptional({ example: '2026-10-06', description: 'Not CUSTOM.' })
  @IsOptional()
  @IsString()
  start_date?: string | null;

  @ApiPropertyOptional({ example: 6, description: '2 to 6. Not CUSTOM.' })
  @IsOptional()
  @IsNumber()
  sessions?: number | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'CUSTOM only: 2 to 6 days.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dates?: string[] | null;

  @ApiPropertyOptional({
    example: '16:30',
    description: 'Optional on dry_run (then the free times come back).',
  })
  @IsOptional()
  @IsString()
  time?: string | null;

  @ApiProperty({ enum: ['PAY_AT_SALON', 'PAY_AS_YOU_GO', 'UPFRONT'] })
  @IsString()
  payment_plan!: string;

  @ApiPropertyOptional({
    type: [MobileProductLineDto],
    description: 'D7: on the first session only.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileProductLineDto)
  products?: MobileProductLineDto[];

  @ApiPropertyOptional({ type: [RoutinePickDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutinePickDto)
  picks?: RoutinePickDto[];

  @ApiPropertyOptional({ example: 1000, description: 'Create only.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  amount_without_tax?: number;

  @ApiPropertyOptional({ example: 50, description: 'Create only.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  tax_amount?: number;

  @ApiPropertyOptional({ example: 0, description: 'Create only.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  discount?: number;

  @ApiPropertyOptional({ example: 1050, description: 'Create only.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  total?: number;
}

/**
 * The mobile app's routine (series) booking.
 *
 * MOBILE ONLY. The business web runs series through /v1/series and
 * /v1/bookings/series-admin and never calls this; nothing here changes what
 * those do. See gostyle-customer-api docs/SERIES_BOOKING_AUDIT.md, E.3.
 *
 * Behind MOBILE_SERIES_BOOKING: off, every route here is a 404.
 *
 * REGISTERED BEFORE MobileBookingController, so no route of that controller
 * can ever be tried first for a path under /mobile-booking/series
 * (route-order.spec.ts).
 */
@ApiTags('mobile')
@Controller('mobile-booking/series')
@UseGuards(MobileSeriesEnabledGuard)
@UseInterceptors(IdempotentInterceptor)
@UsePipes(mobileValidationPipe())
export class MobileSeriesController {
  constructor(
    private readonly handler: MobileSeriesHandler,
    private readonly reads: MobileSeriesReadHandler,
    @Optional() private readonly manage?: MobileSeriesManageHandler,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Preview or book a routine',
    description:
      'dry_run true: the days, and without a time the times free on every ' +
      'day; with a time each session free or not with up to 3 ' +
      'alternatives, the money for the three plans, and the rules. Nothing ' +
      'is saved. Without dry_run: every session is booked as an ordinary ' +
      'booking paid at the salon, all or nothing, and the routine is ' +
      'answered. Only PAY_AT_SALON can be booked for now.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'The same key returns the same routine.',
  })
  @ApiOkResponse({ description: 'dry_run: the preview.' })
  @ApiCreatedResponse({ description: 'Booked: the routine hub.' })
  @ApiConflictResponse({
    description: 'session_not_free: nothing was booked.',
  })
  @ApiUnprocessableEntityResponse({ description: 'The contract envelope.' })
  create(
    @Body() dto: MobileSeriesDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MobileSeriesPreview | MobileSeriesView> {
    // A preview creates nothing, so it is a 200. Set before the handler
    // runs; an error still answers with its own status.
    if (dto.dry_run === true) res.status(200);

    const hasMoney =
      dto.amount_without_tax !== undefined ||
      dto.tax_amount !== undefined ||
      dto.discount !== undefined ||
      dto.total !== undefined;

    return this.handler.execute({
      salonId: dto.salon_id,
      customerId: actor.id ?? 'anonymous',
      claim: {
        dryRun: dto.dry_run === true,
        serviceIds: dto.services.map((s) => s.id),
        stylistId: dto.stylist_id ?? null,
        frequency: dto.frequency,
        startDate: dto.start_date ?? null,
        sessions: dto.sessions ?? null,
        dates: dto.dates ?? null,
        time: dto.time ?? null,
        paymentPlan: dto.payment_plan,
        picks: (dto.picks ?? []).map((p) => ({
          index: p.index,
          date: p.date,
          time: p.time,
          stylistId: p.stylist_id ?? null,
        })),
      },
      products: dto.products ?? [],
      // Missing on a create is refused as amount_mismatch with the right
      // figure, so the app learns the number instead of a bare 400.
      money: hasMoney
        ? {
            amountWithoutTax: dto.amount_without_tax ?? Number.NaN,
            taxAmount: dto.tax_amount ?? Number.NaN,
            discount: dto.discount ?? Number.NaN,
            total: dto.total ?? Number.NaN,
          }
        : null,
      depositPercent: seriesDepositPercent(),
    });
  }

  @Get(':seriesId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The routine hub',
    description:
      'Every session with its state, done / remaining / skipped, the next ' +
      'session, the money and what the customer may do now. The customer ' +
      'who made it, or staff of the salon; anyone else is 404, never 403.',
  })
  @ApiOkResponse({ description: 'The routine.' })
  @ApiNotFoundResponse({ description: 'No such routine, or not yours.' })
  read(
    @Param('seriesId') seriesId: string,
    @CurrentActor() actor: Actor,
  ): Promise<MobileSeriesView> {
    return this.reads.read(seriesId, {
      actorId: actor.id ?? 'anonymous',
      actorKind: actor.kind,
      actorBranchId: actor.branchId,
    });
  }

  @Patch(':seriesId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change a routine',
    description:
      'action SKIP with session_ids: each session is cancelled as the ' +
      "customer's own choice and shown as SKIPPED; the routine goes on. " +
      'Only sessions still to come and outside the 24 hour lock. dry_run ' +
      'true checks and changes nothing (answers the routine as it is). ' +
      'RESCHEDULE, EXTEND, PAUSE and RESUME answer invalid_action for now. ' +
      'The customer who made the routine only; anyone else is 404.',
  })
  @ApiOkResponse({ description: 'The routine, after the change.' })
  @ApiNotFoundResponse({ description: 'No such routine, or not yours.' })
  @ApiUnprocessableEntityResponse({ description: 'The contract envelope.' })
  change(
    @Param('seriesId') seriesId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ): Promise<MobileSeriesView> {
    if (this.manage === undefined) {
      throw MobileContractError.notFoundBooking();
    }
    return this.manage.execute({
      seriesId,
      who: {
        actorId: actor.id ?? 'anonymous',
        actorKind: actor.kind,
        actorBranchId: actor.branchId,
      },
      claim: manageClaimFrom(body),
    });
  }
}
