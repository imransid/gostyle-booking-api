import { Body, Controller, Headers, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import {
  ConfirmBookingHandler,
  type BookingView,
} from '@application/commands/confirm-booking.handler';
import type { PaymentRail } from '@infrastructure/persistence/booking.repository';

export class ConfirmBookingDto {
  @ApiProperty({ example: 'the id returned by POST /holds' })
  @IsUUID()
  holdId!: string;

  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branch = 'marina-walk';

  @ApiProperty({ example: '2026-08-24' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({ example: ['full-colour'], type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  services!: string[];

  @ApiPropertyOptional({ example: 'dana' })
  @IsOptional()
  @IsString()
  customerId = 'dana';

  @ApiPropertyOptional({ enum: ['desk', 'online'], default: 'desk' })
  @IsOptional()
  @IsIn(['desk', 'online'])
  channel = 'desk';

  @ApiPropertyOptional({
    example: 24000,
    description: 'Fils captured. Omit when the requirement was none.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountFils?: number;

  @ApiPropertyOptional({
    enum: ['wallet', 'card', 'apple_pay', 'cash', 'link'],
    description:
      'A link captures nothing yet, so the booking sits at pending_payment.',
  })
  @IsOptional()
  @IsIn(['wallet', 'card', 'apple_pay', 'cash', 'link'])
  rail?: PaymentRail;

  @ApiPropertyOptional({ example: 'pi_abc123' })
  @IsOptional()
  @IsString()
  gatewayRef?: string;

  @ApiPropertyOptional({ example: 'maya' })
  @IsOptional()
  @IsString()
  actorId?: string;
}

@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly handler: ConfirmBookingHandler) {}

  @Post()
  @ApiOperation({
    summary: 'Turn a hold into a booking',
    description:
      'Nine writes, one COMMIT: the booking, its items, the reservations ' +
      're-pointed from the hold, the ledger entry, the history line, the ' +
      'outbox event, the idempotency key, and the hold released. If anything ' +
      'fails, all nine vanish and nothing was charged.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Send the same key on a retry to get the original booking back.',
  })
  @ApiCreatedResponse({ description: 'Confirmed. The booking has a code.' })
  @ApiGoneResponse({ description: 'The hold expired. Nothing was charged.' })
  @ApiConflictResponse({ description: 'The slot went while you were paying.' })
  confirm(
    @Body() dto: ConfirmBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BookingView> {
    return this.handler.execute({
      holdId: dto.holdId,
      branchId: dto.branch,
      customerId: dto.customerId,
      tradingDay: dto.day,
      serviceIds: dto.services,
      channel: dto.channel,
      ...(dto.amountFils !== undefined && dto.rail !== undefined
        ? {
            payment: {
              amountFils: dto.amountFils,
              rail: dto.rail,
              ...(dto.gatewayRef !== undefined
                ? { gatewayRef: dto.gatewayRef }
                : {}),
            },
          }
        : {}),
      ...(dto.actorId !== undefined ? { actorId: dto.actorId } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }
}
