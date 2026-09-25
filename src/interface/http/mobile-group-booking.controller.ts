import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
  UsePipes,
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
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MobileGroupBookingHandler } from '@application/commands/mobile-group-booking.handler';
import { MobileGroupCancelHandler } from '@application/commands/mobile-group-cancel.handler';
import {
  MobileGroupReadHandler,
  type MobileGroupView,
} from '@application/queries/mobile-group-read.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { mobileValidationPipe } from './mobile-validation.pipe';
import {
  MobileLineDto,
  MobileProductLineDto,
} from './mobile-booking.controller';
import {
  MobileGroupEnabledGuard,
  groupDepositPercent,
} from './mobile-group.flag';

export class MobileGroupMemberDto {
  @ApiProperty({ example: 0, description: "The app's own index. Echoed back." })
  @IsInt()
  @Min(0)
  ref!: number;

  @ApiProperty({ enum: ['self', 'registered', 'guest'] })
  @IsString()
  kind!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The account id. Required for self and registered; none for a guest.',
  })
  @IsOptional()
  @IsString()
  id?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Required for a guest. Echoed back for the others; not stored.',
  })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiProperty({
    enum: ['adult', 'child'],
    description: 'A child pays half of each service.',
  })
  @IsString()
  age_group!: string;

  @ApiProperty({ type: [MobileLineDto], description: 'At least one.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileLineDto)
  services!: MobileLineDto[];

  @ApiPropertyOptional({
    type: [MobileProductLineDto],
    description:
      'Variant ids. Refused with products_not_supported unless ' +
      'PRODUCTS_FROM_PLATFORM is on, as for a single booking.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileProductLineDto)
  products?: MobileProductLineDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null or left out: the salon assigns one.',
  })
  @IsOptional()
  @IsString()
  stylist_id?: string | null;
}

export class MobileGroupBookingDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  salon_id!: string;

  @ApiProperty({
    example: '2026-10-11T15:00:00+06:00',
    description: 'When the party arrives. Everyone starts together.',
  })
  @IsISO8601({ strict: true })
  start_time!: string;

  @ApiProperty({ type: [MobileGroupMemberDto], description: '2 to 8.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MobileGroupMemberDto)
  members!: MobileGroupMemberDto[];

  @ApiProperty({ example: 685 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount_without_tax!: number;

  @ApiProperty({ example: 34.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tax_amount!: number;

  @ApiProperty({ example: 0, description: 'A party has no discount (D2).' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Echoed, not applied (D2).',
  })
  @IsOptional()
  @IsString()
  promo_code?: string | null;

  @ApiProperty({ example: 719.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total!: number;

  @ApiPropertyOptional({
    example: 20,
    description:
      "Must be the server's percent (MOBILE_GROUP_DEPOSIT_PERCENT). Left out means that one.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  deposit_percent?: number | null;

  @ApiProperty({ example: 0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advance_paid_amount!: number;

  @ApiProperty({ example: 719.25 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  due_amount!: number;

  @ApiProperty({ enum: ['DRAFT'] })
  @IsString()
  payment_status!: string;

  @ApiProperty({ enum: ['BOOKED'] })
  @IsString()
  status!: string;

  @ApiProperty({ enum: ['GROUP'] })
  @IsString()
  booking_type!: string;
}

/**
 * The mobile app's group booking: one party, one booking.
 *
 * MOBILE ONLY. The business web books parties through /v1/groups and never
 * calls this; nothing here changes what /v1/groups does. See
 * gostyle-customer-api docs/GROUP_BOOKING_PLAN.md.
 *
 * Behind MOBILE_GROUP_BOOKING: off, every route here is a 404.
 *
 * REGISTERED BEFORE MobileBookingController, so no route of that controller
 * can ever be tried first for a path under /mobile-booking/group
 * (route-order.spec.ts).
 */
@ApiTags('mobile')
@Controller('mobile-booking/group')
@UseGuards(MobileGroupEnabledGuard)
@UseInterceptors(IdempotentInterceptor)
@UsePipes(mobileValidationPipe())
export class MobileGroupBookingController {
  constructor(
    private readonly handler: MobileGroupBookingHandler,
    private readonly reads: MobileGroupReadHandler,
    private readonly cancels: MobileGroupCancelHandler,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Book a whole party in one call',
    description:
      'Holds every member at start_time, then books each one as an ' +
      'ordinary booking paid at the salon, linked by the group: all their ' +
      'services, their products, VAT and their share of the deposit. No ' +
      'draft window, so nothing lapses unpaid. Every member or none. The money is the ' +
      "server's: a child pays half of each service, VAT is charged once on " +
      'the party, and a figure that disagrees is a 422 carrying the right one.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'The same key returns the same party.',
  })
  @ApiCreatedResponse({
    description: 'Booked, at payment_status PAY_AFTER_CHECK_IN.',
  })
  @ApiConflictResponse({ description: 'slot_taken: the party no longer fits.' })
  @ApiUnprocessableEntityResponse({ description: 'The contract envelope.' })
  create(
    @Body() dto: MobileGroupBookingDto,
    @CurrentActor() actor: Actor,
  ): Promise<MobileGroupView> {
    return this.handler.execute({
      salonId: dto.salon_id,
      startTime: dto.start_time,
      members: dto.members.map((m) => ({
        ref: m.ref,
        kind: m.kind,
        id: m.id ?? null,
        name: m.name ?? null,
        ageGroup: m.age_group,
        services: m.services,
        products: m.products ?? [],
        stylistId: m.stylist_id ?? null,
      })),
      amountWithoutTax: dto.amount_without_tax,
      taxAmount: dto.tax_amount,
      discount: dto.discount,
      promoCode: dto.promo_code ?? null,
      total: dto.total,
      depositPercent: dto.deposit_percent ?? null,
      advancePaidAmount: dto.advance_paid_amount,
      dueAmount: dto.due_amount,
      paymentStatus: dto.payment_status,
      status: dto.status,
      bookingType: dto.booking_type,
      customerId: actor.id ?? 'anonymous',
      heldDepositPercent: groupDepositPercent(),
    });
  }

  @Get(':groupId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Read a party back',
    description:
      'The same shape the create answered. The booker, anyone in the ' +
      'party, or staff of the salon; anyone else is 404, never 403.',
  })
  @ApiOkResponse({ description: 'The party.' })
  @ApiNotFoundResponse({ description: 'No such party, or not yours.' })
  read(
    @Param('groupId') groupId: string,
    @CurrentActor() actor: Actor,
  ): Promise<MobileGroupView> {
    return this.reads.read(groupId, {
      actorId: actor.id ?? 'anonymous',
      actorKind: actor.kind,
      actorBranchId: actor.branchId,
    });
  }

  @Post(':groupId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel the whole party',
    description:
      'The booker only. Every member is cancelled by the same code a single ' +
      'cancel runs; if any member cannot be cancelled (already checked in, ' +
      'say), nothing is and the answer is 409 cannot_cancel. Sending it ' +
      'again after a part-way failure finishes the job. Answers with the ' +
      'party, read back.',
  })
  @ApiOkResponse({ description: 'Cancelled. The party, read back.' })
  @ApiConflictResponse({ description: 'cannot_cancel: nothing was cancelled.' })
  @ApiNotFoundResponse({ description: 'No such party, or not the booker.' })
  cancel(
    @Param('groupId') groupId: string,
    @CurrentActor() actor: Actor,
  ): Promise<MobileGroupView> {
    return this.cancels.execute(groupId, {
      actorId: actor.id ?? 'anonymous',
      actorKind: actor.kind,
      actorBranchId: actor.branchId,
    });
  }
}
