import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import {
  LifecycleHandler,
  type LifecycleView,
} from '@application/commands/lifecycle.handler';
import type { ActorKind, CancelInitiator } from '@domain/booking/lifecycle';

export class LifecycleDto {
  @ApiPropertyOptional({
    enum: ['customer', 'staff', 'manager', 'system'],
    default: 'staff',
  })
  @IsOptional()
  @IsIn(['customer', 'staff', 'manager', 'system'])
  actor: ActorKind = 'staff';

  @ApiPropertyOptional({ example: 'maya' })
  @IsOptional()
  @IsString()
  actorId?: string;

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
    example: 1755000000000,
    description:
      'Testing only. Pretend now is this epoch millisecond, so the refund ' +
      'bands can be exercised without waiting a day.',
  })
  @IsOptional()
  @IsInt()
  nowMs?: number;
}

@ApiTags('lifecycle')
@Controller('bookings/:id')
export class LifecycleController {
  constructor(private readonly handler: LifecycleHandler) {}

  @Post('check-in')
  @ApiOperation({ summary: 'The customer arrived' })
  @ApiOkResponse({ description: 'Checked in.' })
  @ApiConflictResponse({
    description: 'Not a legal move from the current state.',
  })
  checkIn(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
  ): Promise<LifecycleView> {
    return this.run(id, 'checked_in', dto);
  }

  @Post('start')
  @ApiOperation({ summary: 'Begin the service' })
  start(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
  ): Promise<LifecycleView> {
    return this.run(id, 'in_service', dto);
  }

  @Post('complete')
  @ApiOperation({ summary: 'The work is done, the ticket awaits settlement' })
  complete(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
  ): Promise<LifecycleView> {
    return this.run(id, 'completed', dto);
  }

  @Post('settle')
  @ApiOperation({ summary: 'Paid at the point of sale' })
  settle(
    @Param('id') id: string,
    @Body() dto: LifecycleDto,
  ): Promise<LifecycleView> {
    return this.run(id, 'settled', dto);
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
  ): Promise<LifecycleView> {
    return this.run(id, 'cancelled', dto);
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
  ): Promise<LifecycleView> {
    return this.run(id, 'no_show', dto);
  }

  private run(
    id: string,
    to: Parameters<LifecycleHandler['execute']>[0]['to'],
    dto: LifecycleDto,
  ): Promise<LifecycleView> {
    return this.handler.execute({
      bookingId: id,
      to,
      actor: dto.actor,
      ...(dto.actorId !== undefined ? { actorId: dto.actorId } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.initiatedBy !== undefined
        ? { initiatedBy: dto.initiatedBy }
        : {}),
      ...(dto.vipStandingReservation !== undefined
        ? { vipStandingReservation: dto.vipStandingReservation }
        : {}),
      ...(dto.nowMs !== undefined ? { nowMs: dto.nowMs } : {}),
    });
  }
}
