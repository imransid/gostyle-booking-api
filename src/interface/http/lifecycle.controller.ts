import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import {
  LifecycleHandler,
  type LifecycleView,
} from '@application/commands/lifecycle.handler';
import type { CancelInitiator } from '@domain/booking/lifecycle';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import {
  RescheduleHandler,
  type RescheduleView,
} from '@application/commands/reschedule.handler';
import { ApiGoneResponse, ApiProperty } from '@nestjs/swagger';

export class LifecycleDto {
  @ApiPropertyOptional({
    example: 'customer called to cancel',
    description:
      'Mandatory on cancel, no-show from checked-in, and reschedule.',
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    enum: ['customer', 'salon'],
    default: 'customer',
    description:
      'A salon-initiated cancel refunds in full, whatever the timing.',
  })
  @IsOptional()
  @IsIn(['customer', 'salon'])
  initiatedBy?: CancelInitiator;

  @ApiPropertyOptional({
    description: 'VIP standing reservation. The no-show fee is waived by rule.',
  })
  @IsOptional()
  vipStandingReservation?: boolean;

  @ApiPropertyOptional({
    example: 12000,
    description:
      'Products sold at the till, as a TOTAL. The point of sale owns the ' +
      'line items; this service owns the arithmetic. Never tipped on, never ' +
      'discounted by tier.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  retailMinor?: number;

  @ApiPropertyOptional({
    example: 10,
    description:
      'A percentage of the tippable base, which excludes retail. Use this ' +
      'or tipMinor, not both.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  tipPercent?: number;

  @ApiPropertyOptional({ example: 5000, description: 'A custom tip amount.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  tipMinor?: number;

  @ApiPropertyOptional({ example: 5000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  loyaltyRedeemMinor?: number;

  @ApiPropertyOptional({
    example: { code: 'SUMMER20', percent: 20 },
    description:
      'The promotion presented at the register. The caller validates the ' +
      'code and resolves its rate; marketing owns the registry, not this ' +
      'service. Omit percent to use the house default of 10.',
  })
  @IsOptional()
  @IsObject()
  promo?: { code: string; percent?: number };

  @ApiPropertyOptional({
    example: 'diplomatic exemption on file',
    description: 'A manager may zero the VAT, and must say why.',
  })
  @IsOptional()
  @IsString()
  taxExemptReason?: string;

  @ApiPropertyOptional({ example: 'card' })
  @IsOptional()
  @IsString()
  rail?: string;

  @ApiPropertyOptional({
    example: 1755000000000,
    description:
      'Testing only. Pretend now is this epoch millisecond, so the refund ' +
      'bands can be exercised without waiting a day.',
  })
  @IsOptional()
  @IsInt()
  nowMs?: number;
}

export class RescheduleDto {
  @ApiProperty({
    description:
      'A hold on the NEW slot, placed exactly like any other. The hold did ' +
      'the racing, so by the time this arrives the slot is already protected.',
  })
  @IsUUID()
  holdId!: string;

  @ApiProperty({ example: '2026-09-22' })
  @IsString()
  day!: string;

  @ApiProperty({
    example: 'customer asked to move',
    description: 'Mandatory. A move without a reason is unauditable.',
  })
  @IsString()
  reason!: string;

  @ApiPropertyOptional({ example: 1755000000000, description: 'Testing only.' })
  @IsOptional()
  @IsInt()
  nowMs?: number;
}

@ApiTags('lifecycle')
@Controller('bookings/:id')
export class LifecycleController {
  constructor(
    private readonly handler: LifecycleHandler,
    private readonly reschedules: RescheduleHandler,
  ) {}

  @Post('reschedule')
  @ApiOperation({
    summary: 'Move the booking to a slot already held',
    description:
      'The booking MOVES: same row, same code, new time, move counter up by ' +
      'one. Within policy the deposit carries untouched; inside the late ' +
      'window it is forfeited and the new time is quoted fresh. From the ' +
      'fourth move, a booking carrying no deposit acquires a 20% one.',
  })
  @ApiOkResponse({ description: 'Moved.' })
  @ApiGoneResponse({
    description: 'The new slot went while they were deciding.',
  })
  @ApiConflictResponse({ description: 'This booking cannot be moved.' })
  reschedule(
    @Param('id') id: string,
    @Body() dto: RescheduleDto,
    @CurrentActor() actor: Actor,
  ): Promise<RescheduleView> {
    return this.reschedules.execute({
      bookingId: id,
      holdId: dto.holdId,
      tradingDay: dto.day,
      reason: dto.reason,
      actor: actor.kind,
      actorId: actor.id,
      ...(dto.nowMs !== undefined ? { nowMs: dto.nowMs } : {}),
    });
  }

  @Post('check-in')
  @ApiOperation({ summary: 'The customer arrived' })
  @ApiOkResponse({ description: 'Checked in.' })
  @ApiConflictResponse({
    description: 'Not a legal move from the current state.',
  })
  @ApiForbiddenResponse({ description: 'This actor may not do that.' })
  checkIn(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'checked_in', dto, actor);
  }

  @Post('start')
  @ApiOperation({ summary: 'Begin the service' })
  start(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'in_service', dto, actor);
  }

  @Post('complete')
  @ApiOperation({ summary: 'The work is done, the ticket awaits settlement' })
  complete(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'completed', dto, actor);
  }

  @Post('settle')
  @ApiOperation({ summary: 'Paid at the point of sale' })
  settle(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'settled', dto, actor);
  }

  @Post('cancel')
  @ApiOperation({
    summary: 'Call the visit off',
    description:
      'The money outcome is computed from how far away the start is, and ' +
      'returned so the desk can read it to the customer. Capacity is released ' +
      'in the same transaction.',
  })
  @ApiForbiddenResponse({ description: 'This actor may not cancel.' })
  cancel(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'cancelled', dto, actor);
  }

  @Post('no-show')
  @ApiOperation({
    summary: 'The customer never arrived',
    description:
      'The deposit is forfeited, unless this is a VIP standing reservation, ' +
      'where the fee is waived by rule.',
  })
  noShow(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
    @CurrentActor() actor: Actor,
  ): Promise<LifecycleView> {
    return this.run(id, 'no_show', dto, actor);
  }

  private run(
    id: string,
    to: Parameters<LifecycleHandler['execute']>[0]['to'],
    dto: LifecycleDto,
    actor: Actor,
  ): Promise<LifecycleView> {
    return this.handler.execute({
      bookingId: id,
      to,
      // THE POINT OF ALL THIS.
      //
      // checkTransition() has known since the state machine was written that
      // a customer may not check someone in. It now gets the VERIFIED answer
      // instead of whatever the request body claimed. The dto no longer has
      // an `actor` field at all, so there is nothing to spoof.
      actor: actor.kind,
      actorId: actor.id,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.initiatedBy !== undefined
        ? { initiatedBy: dto.initiatedBy }
        : {}),
      ...(dto.vipStandingReservation !== undefined
        ? { vipStandingReservation: dto.vipStandingReservation }
        : {}),
      ...(dto.nowMs !== undefined ? { nowMs: dto.nowMs } : {}),
      checkout: {
        ...(dto.retailMinor !== undefined
          ? { retailFils: dto.retailMinor }
          : {}),
        ...(dto.tipMinor !== undefined ? { tipFils: dto.tipMinor } : {}),
        ...(dto.tipPercent !== undefined ? { tipPercent: dto.tipPercent } : {}),
        ...(dto.loyaltyRedeemMinor !== undefined
          ? { loyaltyRedeemFils: dto.loyaltyRedeemMinor }
          : {}),
        ...(dto.promo !== undefined ? { promo: dto.promo } : {}),
        ...(dto.taxExemptReason !== undefined
          ? { taxExemptReason: dto.taxExemptReason }
          : {}),
        ...(dto.rail !== undefined ? { rail: dto.rail } : {}),
      },
    });
  }
}
