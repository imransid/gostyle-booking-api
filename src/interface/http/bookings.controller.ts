import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { unshout } from '@application/contract/wire';
import {
  GetBookingHandler,
  type BookingDetailView,
} from '@application/queries/get-booking.handler';
import {
  PaymentLinkHandler,
  type PaymentLinkView,
} from '@application/commands/payment-link.handler';
import {
  ConfirmBookingHandler,
  type BookingView,
} from '@application/commands/confirm-booking.handler';
import type { PaymentRail } from '@infrastructure/persistence/booking.repository';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

/** The domain rails the shouted request enum folds back down to. */
const PAYMENT_RAILS = ['wallet', 'card', 'apple_pay', 'cash', 'link'] as const;

export class ConfirmBookingDto {
  @ApiProperty({ example: 'the id returned by POST /v1/holds' })
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
    description:
      'Minor units captured (fils; 24000 is AED 240.00). Omit when the ' +
      'requirement was none.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountMinor?: number;

  @ApiPropertyOptional({
    enum: ['WALLET', 'CARD', 'APPLE_PAY', 'CASH', 'LINK'],
    description:
      'A link captures nothing yet, so the booking sits at PENDING_PAYMENT.',
  })
  @IsOptional()
  @IsIn(['WALLET', 'CARD', 'APPLE_PAY', 'CASH', 'LINK'])
  rail?: Uppercase<PaymentRail>;

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
  constructor(
    private readonly handler: ConfirmBookingHandler,
    private readonly detail: GetBookingHandler,
    private readonly links: PaymentLinkHandler,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'One booking, with its items, its ledger and its history',
    description:
      'The whole drawer in one round trip. Money is in minor units and every ' +
      'status is shouted, like everywhere else.',
  })
  @ApiOkResponse({ description: 'The booking.' })
  @ApiNotFoundResponse({ description: 'No such booking.' })
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BookingDetailView> {
    return this.detail.execute(id);
  }

  @Post(':id/payment-link')
  @ApiOperation({
    summary: 'Send the customer a payment link',
    description:
      'Moves the booking to PENDING_PAYMENT and opens the window: the ' +
      'shorter of six hours and the time until two hours before the start. ' +
      'Refused when the start is already inside that cutoff, because a link ' +
      'that expired before it was sent holds the slot and pays for nothing.',
  })
  @ApiOkResponse({ description: 'The link window.' })
  @ApiNotFoundResponse({ description: 'No such booking.' })
  @ApiConflictResponse({
    description: 'Not a live booking, or the start is too close.',
  })
  paymentLink(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<PaymentLinkView> {
    return this.links.execute(id, { kind: actor.kind, id: actor.id });
  }

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
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentActor() actor?: Actor,
  ): Promise<BookingView> {
    return this.handler.execute({
      holdId: dto.holdId,
      branchId: dto.branch,
      customerId: dto.customerId,
      tradingDay: dto.day,
      serviceIds: dto.services,
      channel: dto.channel,
      ...(dto.amountMinor !== undefined && dto.rail !== undefined
        ? {
            payment: {
              amountFils: dto.amountMinor,
              rail: unshout(dto.rail, PAYMENT_RAILS)!,
              ...(dto.gatewayRef !== undefined
                ? { gatewayRef: dto.gatewayRef }
                : {}),
            },
          }
        : {}),
      // From the verified token, never the body. A client could name
      // anyone; the token cannot.
      ...(actor !== undefined ? { actorId: actor.id } : {}),
      ...(actor?.kind === 'customer' ? { customerId: actor.id } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }
}
