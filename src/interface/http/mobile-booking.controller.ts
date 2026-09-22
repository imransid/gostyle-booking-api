import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiPropertyOptional,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MobileBookingHandler } from '@application/commands/mobile-booking.handler';
import { MAX_PRODUCT_QUANTITY } from '@domain/booking/mobile-products';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { mobileValidationPipe } from './mobile-validation.pipe';
import type { MobilePaymentMethod } from '@domain/booking/mobile-contract';
import { parseFilter } from '@domain/booking/booking-shelf';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
import { MobileContractError } from '@application/commands/mobile-booking.error';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class MobileLineDto {
  @ApiProperty({ example: 'svc_fade' })
  @IsString()
  id!: string;

  @ApiProperty({
    example: 120,
    description: 'Decimal AED. Verified, never trusted.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;
}

/** A product line: a line plus a quantity. `id` is the VARIANT id. */
export class MobileProductLineDto extends MobileLineDto {
  @ApiPropertyOptional({
    example: 1,
    default: 1,
    minimum: 1,
    maximum: MAX_PRODUCT_QUANTITY,
    description: 'Whole units. Omitted means 1. `amount` is the UNIT price.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PRODUCT_QUANTITY)
  quantity?: number;
}

export class MobileBookingDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  salon_id!: string;

  @ApiProperty({ type: [MobileLineDto] })
  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one service.' })
  @ValidateNested({ each: true })
  @Type(() => MobileLineDto)
  services!: MobileLineDto[];

  @ApiPropertyOptional({
    type: [MobileProductLineDto],
    description:
      'Refused with 422 products_not_supported unless PRODUCTS_FROM_PLATFORM ' +
      'is on. With it on, each line is checked against the platform ' +
      'catalogue: unknown_product, amount_mismatch, currency_mismatch, ' +
      'out_of_stock.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileProductLineDto)
  products?: MobileProductLineDto[];

  @ApiProperty({
    type: [String],
    example: ['maya'],
    description:
      'One for the whole visit, or one per service in the same order. An ' +
      'EMPTY array is refused: the staff directory publishes no skills, so ' +
      '"the salon assigns a qualified one" cannot be done honestly.',
  })
  @IsArray()
  @IsString({ each: true })
  stylists!: string[];

  @ApiProperty({ example: '2026-09-20' })
  @Matches(DAY, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiProperty({ example: '2026-09-20T20:00:00+04:00' })
  @IsISO8601({ strict: true })
  start_time!: string;

  @ApiProperty({ example: '2026-09-20T20:45:00+04:00' })
  @IsISO8601({ strict: true })
  end_time!: string;

  @ApiProperty({ example: 225 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount_without_tax!: number;

  @ApiProperty({ example: 11.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tax_amount!: number;

  @ApiProperty({ example: 20 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount!: number;

  @ApiPropertyOptional({ example: 'GOSTYLE20', nullable: true })
  @IsOptional()
  @IsString()
  promo_code?: string | null;

  @ApiProperty({ example: 216.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total!: number;

  @ApiProperty({ example: 0, description: 'Always 0 on create.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advance_paid_amount!: number;

  @ApiProperty({ example: 216.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  due_amount!: number;

  @ApiProperty({ enum: ['DRAFT'], description: 'Only DRAFT on create (§4).' })
  @IsString()
  payment_status!: string;

  @ApiProperty({ enum: ['BOOKED'], description: 'Only BOOKED on create (§4).' })
  @IsString()
  status!: string;

  @ApiProperty({
    enum: ['SINGLE', 'ROUTINE'],
    description:
      'ROUTINE is refused with 422 routine_not_supported: this payload ' +
      'carries no recurrence rule, and a recurring booking that creates one ' +
      'visit is a customer expecting twelve.',
  })
  @IsIn(['SINGLE', 'ROUTINE'])
  booking_type!: string;
}

export class MobilePaymentDto {
  @ApiProperty({
    enum: ['PARTIALLY', 'FULLY_PAID', 'PAY_AFTER_CHECK_IN'],
    description: 'Never back to DRAFT (§11.1).',
  })
  @IsString()
  payment_status!: string;

  @ApiPropertyOptional({
    enum: ['WALLET', 'CARD', 'GOOGLE', 'APPLE', 'OTHERS'],
    description: 'Required unless PAY_AFTER_CHECK_IN.',
  })
  @IsOptional()
  @IsIn(['WALLET', 'CARD', 'GOOGLE', 'APPLE', 'OTHERS'])
  payment_method?: MobilePaymentMethod;

  @ApiProperty({
    example: 54.07,
    description: 'What the gateway actually took.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advance_paid_amount!: number;

  @ApiPropertyOptional({
    example: 162.18,
    description: 'Derived as total - advance_paid_amount; verified when sent.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  due_amount?: number;

  @ApiPropertyOptional({
    example: 'pi_3Qk2xLJ8n',
    description:
      'The gateway\u2019s own id. Required whenever money moved, and UNIQUE: ' +
      'the same reference twice returns the same booking rather than ' +
      'recording a second payment (§11.3).',
  })
  @IsOptional()
  @IsString()
  payment_reference?: string;
}

/**
 * The mobile app's one-call create.
 *
 * WHAT IT IS. A thin orchestration over the three calls the desk makes:
 * place a hold, confirm it on the LINK rail so the booking sits at
 * PENDING_PAYMENT with a window on it, then issue the payment link. Nothing
 * here re-implements any of them, and the nine-write confirm transaction is
 * untouched.
 *
 * WHY IT EXISTS. The desk flow is three round trips on purpose -- an agent
 * reads the offers, talks to the customer, then commits. A phone collected
 * all three answers on one screen before it submitted, so replaying the
 * conversation costs two round trips over mobile data and two more chances
 * to lose the slot in between.
 *
 * THE CUSTOMER COMES FROM THE TOKEN. §1 of the contract says so, and the
 * payload has no field for it.
 */
@ApiTags('mobile')
@Controller('mobile-booking')
@UseInterceptors(IdempotentInterceptor)
// Field errors answer in the CONTRACT's envelope, not this service's. See
// mobile-validation.pipe.ts: without it the app parses one shape for a DTO
// failure and another for a handler failure.
@UsePipes(mobileValidationPipe())
export class MobileBookingController {
  constructor(
    private readonly handler: MobileBookingHandler,
    private readonly bookings: BookingRepository,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a booking in one call',
    description:
      'Holds the slot, confirms it on the LINK rail, and issues the payment ' +
      'link. Money in the payload is VERIFIED against the server’s own ' +
      'quote and never persisted from the client (§3); a mismatch is a 422 ' +
      'carrying the correct figure so the app can show the customer what ' +
      'changed. If anything after the hold fails, the hold is released ' +
      'immediately rather than holding a chair until a sweeper notices.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A booking is money. The same key returns the same booking (§7).',
  })
  @ApiCreatedResponse({ description: 'Created, at payment_status DRAFT.' })
  @ApiUnprocessableEntityResponse({
    description:
      'The contract’s own envelope: { detail, code: "validation_error", ' +
      'errors: [{ field, code, message, expected }] }.',
  })
  create(
    @Body() dto: MobileBookingDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<unknown> {
    return this.handler.execute({
      salonId: dto.salon_id,
      services: dto.services,
      products: dto.products,
      stylists: dto.stylists,
      date: dto.date,
      startTime: dto.start_time,
      endTime: dto.end_time,
      amountWithoutTax: dto.amount_without_tax,
      taxAmount: dto.tax_amount,
      discount: dto.discount,
      promoCode: dto.promo_code ?? null,
      total: dto.total,
      advancePaidAmount: dto.advance_paid_amount,
      dueAmount: dto.due_amount,
      paymentStatus: dto.payment_status,
      status: dto.status,
      bookingType: dto.booking_type,
      // From the verified token, never the body (§1).
      customerId: actor.id ?? 'anonymous',
      idempotencyKey,
    });
  }

  /**
   * booking-list.md §1. DECLARED BEFORE `:id`, and that is not cosmetic --
   * Nest matches in declaration order, and a `@Get(':id')` above this one
   * would swallow nothing here (the path is empty) but the reverse habit is
   * what put `read-models.controller.ts` in its own file. Keep the specific
   * route first.
   */
  @Get()
  @HttpCode(200)
  @ApiOperation({
    summary: "The caller's own bookings, one shelf at a time",
    description:
      'WHOSE LIST IS NOT A PARAMETER. The customer comes from the token, ' +
      'because an endpoint that takes a customer id is an enumeration of ' +
      'every booking in the system behind one valid login.\n\n' +
      '`counts` carries all three tab badges so the app does not ask three ' +
      'times for numbers it draws at once. `recurring` is always 0 and its ' +
      'page always empty: nothing can reach that shelf until series are ' +
      'wired, and an empty page is a truer answer than a 422.\n\n' +
      '`salon`, `can_cancel` and `can_reschedule` of §3 are NOT returned ' +
      'here -- see §9. `salon_id` is, so the caller can resolve them.',
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    enum: ['upcoming', 'recurring', 'archive'],
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 20 })
  @ApiOkResponse({ description: 'A page of the shelf, plus all three counts.' })
  @ApiUnprocessableEntityResponse({
    description: 'filter was not one of the three: code `invalid_filter`.',
  })
  list(
    @CurrentActor() actor: Actor,
    @Query('filter') filter?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    const shelf = parseFilter(filter);
    if (shelf === null) {
      throw MobileContractError.invalidFilter(filter ?? '');
    }

    return this.handler.list({
      customerId: actor.id ?? 'anonymous',
      filter: shelf,
      page: clampInt(page, 1, 1, 10_000),
      // §1: capped server-side at 50. A page is a quote per row.
      pageSize: clampInt(pageSize, 20, 1, 50),
    });
  }

  /**
   * The intervals given staff are already occupied for.
   *
   * DECLARED BEFORE `:id`, and here that matters: Nest matches in order, so
   * `@Get(':id')` above this would swallow `/busy` as a booking id.
   *
   * Exists for the customer app's slot picker, which lives in
   * gostyle-customer-api and built its grid from a `booking` table in the
   * PLATFORM database -- one this service has never written to. It therefore
   * offered slots that were already sold, and the customer learned so only
   * when the booking was refused.
   *
   * The picker keeps its own grid (shifts, breaks, opening hours, lead time
   * are all platform facts it holds and this service does not). It needed
   * exactly one thing from here: who is already busy.
   */
  @Get('busy')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Occupied intervals for a set of staff, for a slot picker',
    description:
      'Bookings live in this service, so nothing else can answer this ' +
      'truthfully. Uses BLOCKING_STATES -- the engine own answer to "does ' +
      'this still occupy a chair" -- which includes completed and settled: ' +
      'the visit is over but it happened, and pretending the time is free ' +
      'would let a booking land on top of it.',
  })
  @ApiQuery({ name: 'branchId', required: true })
  @ApiQuery({
    name: 'staffIds',
    required: true,
    description: 'Comma separated.',
  })
  @ApiQuery({ name: 'from', required: true, example: '2026-09-21T00:00:00Z' })
  @ApiQuery({ name: 'to', required: true, example: '2026-09-23T00:00:00Z' })
  @ApiOkResponse({ description: '{ busy: [{ staff_id, start_at, end_at }] }' })
  async busy(
    @Query('branchId') branchId?: string,
    @Query('staffIds') staffIds?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    const ids = (staffIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const fromAt = new Date(from ?? '');
    const toAt = new Date(to ?? '');

    /**
     * AN UNANSWERABLE QUERY RETURNS NOTHING, not an empty success.
     *
     * An empty `busy` list means "these people are free", and answering that
     * to a malformed window would put the picker back to offering sold
     * slots -- the exact bug this endpoint exists to end. Refused loudly
     * instead.
     */
    if (
      !branchId ||
      ids.length === 0 ||
      Number.isNaN(fromAt.getTime()) ||
      Number.isNaN(toAt.getTime()) ||
      toAt <= fromAt
    ) {
      throw MobileContractError.of(
        'from',
        'invalid_window',
        'branchId, staffIds and a from/to window are all required.',
      );
    }

    const busy = await this.bookings.busyFor({
      branchId,
      staffIds: ids,
      from: fromAt,
      to: toAt,
    });

    return {
      /**
       * THE ENGINE'S OWN BOOKABLE DAY, so callers stop guessing it.
       *
       * `feasibleSet` searches DAY_START_MIN..DAY_END_MIN and nothing
       * outside it, whatever hours a branch keeps. The customer app's picker
       * reads the branch's real hours, so a salon opening at 09:00 had its
       * first hour offered and then refused -- "09:00 is no longer
       * available" about a slot that was never reachable.
       *
       * Sent with the busy window because the caller is already here, and
       * READ rather than copied: a constant repeated in another service is
       * the one that goes stale (CLAUDE.md 4). The right fix is a per-branch
       * trading day; until then this at least means only one service
       * believes it knows the hours.
       */
      day: { from_min: DAY_START_MIN, to_min: DAY_END_MIN },
      busy: busy.map((b) => ({
        staff_id: b.staffId,
        start_at: b.startAt.toISOString(),
        end_at: b.endAt.toISOString(),
      })),
    };
  }

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Read one booking',
    description:
      'The §8 shape, whatever state the booking is in, so the confirmation ' +
      'screen, the pass and the history all read the same object. A booking ' +
      'the caller may not see is 404, NEVER 403 — a 403 confirms the id ' +
      'exists, which is what an enumerator is trying to learn.',
  })
  @ApiOkResponse({ description: 'The booking, in the §8 shape.' })
  @ApiNotFoundResponse({
    description: 'No such booking, or not the caller\u2019s.',
  })
  read(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    return this.handler.read({
      bookingId: id,
      actorId: actor.id ?? 'anonymous',
      actorKind: actor.kind,
      // Null means every branch, which is what a company owner carries.
      actorBranchId: actor.branchId,
    });
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record the payment',
    description:
      'Called once the gateway answers. Writes the ledger entry, moves the ' +
      'payment state and CLEARS the draft hold window in one transaction — ' +
      'a payment recorded without clearing it leaves the sweeper free to ' +
      'expire a booking that has been paid for. Only from DRAFT; anything ' +
      'else is 409 already_paid. The same payment_reference twice returns ' +
      'the same booking rather than recording a second payment.',
  })
  @ApiOkResponse({ description: 'Recorded. The full booking, §8 shape.' })
  @ApiConflictResponse({
    description: 'Already paid, or the draft hold expired.',
  })
  pay(
    @Param('id') id: string,
    @Body() dto: MobilePaymentDto,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    return this.handler.recordPayment({
      bookingId: id,
      actorId: actor.id ?? 'anonymous',
      actorKind: actor.kind,
      actorBranchId: actor.branchId,
      paymentStatus: dto.payment_status,
      paymentMethod: dto.payment_method ?? null,
      advancePaidAmount: dto.advance_paid_amount,
      dueAmount: dto.due_amount ?? null,
      paymentReference: dto.payment_reference ?? null,
    });
  }
}

/**
 * A query integer, clamped rather than refused.
 *
 * `?page=0` and `?page=abc` are client bugs that cost the customer their
 * booking history if answered with a 422. The list has one refusal (§5) and
 * it is `filter`, because that one changes WHICH bookings come back; a
 * nonsense page number only changes how many.
 */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
