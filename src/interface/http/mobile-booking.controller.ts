import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Get,
  Param,
  Patch,
  Post,
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
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { MobileBookingHandler } from '@application/commands/mobile-booking.handler';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { mobileValidationPipe } from './mobile-validation.pipe';
import type { MobilePaymentMethod } from '@domain/booking/mobile-contract';
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
    type: [MobileLineDto],
    description:
      'REFUSED with 422 products_not_supported when non-empty. There is no ' +
      'product catalogue to price a line against, and a product silently ' +
      'dropped from a basket is money the salon does not take.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileLineDto)
  products?: MobileLineDto[];

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
  constructor(private readonly handler: MobileBookingHandler) {}

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
