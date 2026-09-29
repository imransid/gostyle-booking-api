import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
  UsePipes,
  Optional,
  Patch,
  ValidationPipe,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import {
  ApiBody,
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
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import {
  MobileSeriesHandler,
  type AlternativeRule,
  type MobileSeriesPreview,
  type RoutineContractOptions,
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
  MOBILE_ROUTINE_CONTRACT,
  MobileSeriesEnabledGuard,
  seriesDepositPercent,
} from './mobile-series.flag';
import { MobileSeriesManageHandler } from '@application/commands/mobile-series-manage.handler';
import { manageClaimFrom } from '@domain/booking/mobile-series-manage';
import { MobileContractError } from '@application/commands/mobile-booking.error';
import {
  MobileSeriesCancelHandler,
  type MobileSeriesCancelPreview,
} from '@application/commands/mobile-series-cancel.handler';
import { cancelClaimFrom } from '@domain/booking/mobile-series-cancel';

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

export const ALTERNATIVE_RULES: readonly AlternativeRule[] = [
  'SAME_STYLIST_FORWARD',
];

/** The most alternatives one session may ask for (customer-api keeps 3). */
export const ALTERNATIVES_MAX = 12;

/**
 * The create body with the app team's routine contract options
 * (MOBILE_ROUTINE_CONTRACT). Only customer-api's new routes send them; the
 * old route never does. All optional.
 *
 * Step B1 accepts them and carries them to the handler. Each one is read
 * from its own step on (B2 to B6); until then it changes nothing.
 */
export class MobileRoutineContractDto extends MobileSeriesDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Any Available Expert: the stylists who can do every service, as ' +
      'customer-api measures skills.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  stylist_candidates?: string[];

  @ApiPropertyOptional({
    description: "Check sessions past 90 days against today's calendar.",
  })
  @IsOptional()
  @IsBoolean()
  check_later?: boolean;

  @ApiPropertyOptional({
    description: 'Say why a session is not free.',
  })
  @IsOptional()
  @IsBoolean()
  with_reasons?: boolean;

  @ApiPropertyOptional({ enum: ALTERNATIVE_RULES })
  @IsOptional()
  @IsIn(ALTERNATIVE_RULES)
  alternative_rule?: AlternativeRule;

  @ApiPropertyOptional({ minimum: 1, maximum: ALTERNATIVES_MAX })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(ALTERNATIVES_MAX)
  alternatives_max?: number;

  @ApiPropertyOptional({
    description: 'A pick must be one the alternatives rule would offer.',
  })
  @IsOptional()
  @IsBoolean()
  strict_picks?: boolean;
}

/**
 * The options every body at the edge is validated with: main.ts's global
 * ValidationPipe, word for word. The create body is validated by
 * MobileSeriesBodyPipe instead of that pipe (see SeriesBody), so it must be
 * validated exactly as that pipe would: same options, same 400.
 */
export const EDGE_VALIDATION = {
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
} as const;

/**
 * The create body, validated against the class the flag says.
 *
 * Off (MOBILE_ROUTINE_CONTRACT): the old MobileSeriesDto, with the global
 * pipe's own options, so every body gets exactly today's answer, a body
 * with a new option included ("property check_later should not exist").
 * On: MobileRoutineContractDto, which adds the options and nothing else.
 *
 * Why not simply add the fields to MobileSeriesDto: the global pipe runs
 * first and reads the param's declared class, fixed at boot, so it would
 * accept the options whatever the flag says.
 */
@Injectable()
export class MobileSeriesBodyPipe implements PipeTransform {
  private readonly edge = new ValidationPipe(EDGE_VALIDATION);

  transform(value: unknown): Promise<unknown> {
    return this.edge.transform(value, {
      type: 'body',
      data: undefined,
      metatype: MOBILE_ROUTINE_CONTRACT()
        ? MobileRoutineContractDto
        : MobileSeriesDto,
    });
  }
}

/**
 * The raw request body, exactly as @Body() gives it, as a CUSTOM param. The
 * global ValidationPipe and the controller's mobile pipe both pass a custom
 * param over untouched (validateCustomDecorators is off), which leaves the
 * validation to MobileSeriesBodyPipe alone.
 */
export const SeriesBody = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<{ body?: unknown }>().body,
);

/**
 * The contract's options in our words, or null when none was sent: the old
 * route's command stays exactly as it was.
 */
export function routineContractOf(
  dto: MobileSeriesDto,
): RoutineContractOptions | null {
  if (!(dto instanceof MobileRoutineContractDto)) return null;
  const sent = [
    dto.stylist_candidates,
    dto.check_later,
    dto.with_reasons,
    dto.alternative_rule,
    dto.alternatives_max,
    dto.strict_picks,
  ].some((v) => v !== undefined && v !== null);
  if (!sent) return null;
  return {
    stylistCandidates: dto.stylist_candidates ?? null,
    checkLater: dto.check_later === true,
    withReasons: dto.with_reasons === true,
    alternativeRule: dto.alternative_rule ?? null,
    alternativesMax: dto.alternatives_max ?? null,
    strictPicks: dto.strict_picks === true,
  };
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
    @Optional() private readonly cancels?: MobileSeriesCancelHandler,
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
  // The published body is the old one: the contract's options are
  // customer-api's to send, behind MOBILE_ROUTINE_CONTRACT.
  @ApiBody({ type: MobileSeriesDto })
  create(
    // NOT @Body(): see MobileSeriesBodyPipe for why the flag needs this.
    @SeriesBody(MobileSeriesBodyPipe) dto: MobileSeriesDto,
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
    const contract = routineContractOf(dto);

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
      // Only when an option was sent, so the old route's command is
      // exactly what it was.
      ...(contract === null ? {} : { contract }),
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
      'RESCHEDULE moves one session (session_id, date, time). EXTEND adds sessions (sessions, or dates for CUSTOM; picks for busy ones); its dry_run answers the new sessions and their money. PAUSE (until, reason, note) moves the sessions to the resume date onwards and books them there; RESUME (frequency, time, stylist_id to customize) moves them back to tomorrow onwards. Their dry runs answer the moved sessions. ' +
      'The customer who made the routine only; anyone else is 404.',
  })
  @ApiOkResponse({ description: 'The routine, after the change.' })
  @ApiNotFoundResponse({ description: 'No such routine, or not yours.' })
  @ApiUnprocessableEntityResponse({ description: 'The contract envelope.' })
  change(
    @Param('seriesId') seriesId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ): Promise<MobileSeriesView | MobileSeriesPreview> {
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
      depositPercent: seriesDepositPercent(),
    });
  }

  @Post(':seriesId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a routine',
    description:
      "Every session still to come is cancelled as the customer's own " +
      "cancel, under the single booking's refund rules (inside the 24 hour " +
      'lock: a late cancel), and the routine ends. Sessions never booked ' +
      'are marked skipped. Optional reason: NOT_SATISFIED, TOO_EXPENSIVE, ' +
      "MOVING or OTHER, written in each cancelled booking's history and on " +
      'the series.cancelled event. dry_run true answers the refund summary ' +
      'and the routine as it is, and changes nothing. Allowed while the hub ' +
      'shows can.cancel, else cannot_cancel. The customer who made the ' +
      'routine only; anyone else is 404.',
  })
  @ApiOkResponse({
    description:
      'The routine, ended. With dry_run: { dry_run, summary, routine }.',
  })
  @ApiNotFoundResponse({ description: 'No such routine, or not yours.' })
  @ApiUnprocessableEntityResponse({ description: 'The contract envelope.' })
  cancel(
    @Param('seriesId') seriesId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ): Promise<MobileSeriesView | MobileSeriesCancelPreview> {
    if (this.cancels === undefined) {
      throw MobileContractError.notFoundBooking();
    }
    return this.cancels.execute({
      seriesId,
      who: {
        actorId: actor.id ?? 'anonymous',
        actorKind: actor.kind,
        actorBranchId: actor.branchId,
      },
      claim: cancelClaimFrom(body),
    });
  }
}
