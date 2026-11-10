import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  OnModuleInit,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Public } from '../../auth/public.decorator';
import {
  PosTicketPaidHandler,
  type PosTicketPaidView,
} from '@application/commands/pos-ticket-paid.handler';
import { verifyHmacSha256Hex } from '@infrastructure/security/hmac';
import { posCallbackSecret } from '@infrastructure/security/pos-callback-secret';

export class PosTicketDocumentDto {
  @ApiProperty({ example: 'RECEIPT', enum: ['RECEIPT', 'INVOICE'] })
  @IsIn(['RECEIPT', 'INVOICE'])
  type!: 'RECEIPT' | 'INVOICE';

  @ApiProperty({ example: 'R-118' })
  @IsString()
  @Length(1, 64)
  number!: string;
}

/** The body the platform signs (docs/booking-pos-tickets-plan.md, P9). */
/**
 * ANY 8-4-4-4-12 hex id, not class-validator's @IsUUID().
 *
 * @IsUUID() insists on an RFC 4122 version and variant nibble, and the
 * platform's own ids do not all carry one: its seeded dev and test tenant is
 * 00000000-0000-0000-0000-000000000001. The first live run refused the paid
 * callback for that tenant with "tenantId must be a UUID" (400) on every
 * retry, while every gRPC call for the same tenant went through. The ids are
 * the platform's, so this accepts what the platform issues; the handler's
 * own UUID_RE is the same shape.
 */
const ANY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_MESSAGE = '$property must be a UUID (8-4-4-4-12 hex)';

export class PosTicketPaidDto {
  @ApiProperty()
  @Matches(ANY_UUID, { message: UUID_MESSAGE })
  tenantId!: string;
  @ApiProperty()
  @Matches(ANY_UUID, { message: UUID_MESSAGE })
  bookingId!: string;
  @ApiProperty()
  @Matches(ANY_UUID, { message: UUID_MESSAGE })
  ticketId!: string;

  @ApiProperty({ example: '#T-42' })
  @IsString()
  @Length(1, 32)
  ticketNumber!: string;

  @ApiPropertyOptional({ example: '2026-11-04T11:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  @ApiProperty({ description: 'The cashier who took the money.' })
  @Matches(ANY_UUID, { message: UUID_MESSAGE })
  cashierId!: string;

  @ApiProperty({ example: 21000 }) @IsInt() @Min(0) totalMinor!: number;
  @ApiProperty({ example: 5000 }) @IsInt() @Min(0) depositAppliedMinor!: number;
  @ApiProperty({ example: 238 })
  @IsInt()
  @Min(0)
  depositAppliedVatMinor!: number;

  @ApiProperty({ type: [PosTicketDocumentDto] })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PosTicketDocumentDto)
  documents!: PosTicketDocumentDto[];
}

/**
 * Service-to-service: the platform's POS says a booked visit's ticket is
 * paid (gostyle-platform docs/booking-pos-tickets-plan.md, B6).
 *
 * NO TOKEN, A SIGNATURE. @Public() for the guard, and an HMAC-SHA256 over
 * the RAW body in `x-signature`, with POS_CALLBACK_SECRET (the platform's
 * BOOKING_API_CALLBACK_SECRET) -- the payment webhook's scheme, through the
 * same helper. Fails closed: with no secret in production, every call is
 * refused.
 *
 * Idempotent on the ticket. The platform's outbox retries until it gets a
 * 2xx or 409 ALREADY_SETTLED, so the same payment arriving twice answers
 * `alreadySettled: true` and writes nothing.
 */
@ApiTags('internal')
@Controller('internal/pos')
@Public()
export class InternalPosController implements OnModuleInit {
  private static readonly log = new Logger(InternalPosController.name);

  constructor(private readonly paid: PosTicketPaidHandler) {}

  onModuleInit(): void {
    if (posCallbackSecret() === null) {
      InternalPosController.log.error(
        'POS_CALLBACK_SECRET is not set: every POST ' +
          '/v1/internal/pos/ticket-paid is refused (401) until it is, and ' +
          'paid bookings settle only through the safety net.',
      );
    }
  }

  @Post('ticket-paid')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The POS took the balance: settle the booking (platform only)',
    description:
      'Signed by the platform, never called by a person. Writes the deposit ' +
      'draw-down (applied_at_pos, posTransactionId = ticketId), credits any ' +
      'leftover deposit to the wallet, and moves the booking completed -> ' +
      'settled with the cashier as the staff actor. 200 with ' +
      'alreadySettled for a replay of the same ticket; 409 ALREADY_SETTLED ' +
      'when another ticket settled it; 409 BOOKING_STATE_INVALID when it is ' +
      'not completed.',
  })
  @ApiHeader({
    name: 'x-signature',
    description: 'Hex HMAC-SHA256 over the raw body, no prefix.',
  })
  @ApiOkResponse({ description: '{ bookingId, code, status, alreadySettled }' })
  @ApiUnauthorizedResponse({ description: 'The signature did not verify.' })
  async ticketPaid(
    @Body() dto: PosTicketPaidDto,
    @Headers('x-signature') signature: string | undefined,
    @Req() req: { rawBody?: Buffer },
  ): Promise<PosTicketPaidView> {
    // The RAW bytes, not the parsed body re-serialised: JSON round-tripping
    // changes key order and whitespace, and the signature never matches.
    const raw = req.rawBody?.toString('utf8');
    const secret = posCallbackSecret();

    if (
      secret === null ||
      raw === undefined ||
      signature === undefined ||
      !verifyHmacSha256Hex(secret, raw, signature.trim())
    ) {
      // Deliberately vague: telling an unsigned caller WHY it failed helps
      // them iterate towards a signature that works.
      throw new UnauthorizedException('Signature verification failed.');
    }

    return this.paid.settle({
      tenantId: dto.tenantId,
      bookingId: dto.bookingId,
      ticketId: dto.ticketId,
      ticketNumber: dto.ticketNumber,
      paidAt: dto.paidAt ?? null,
      cashierId: dto.cashierId,
      totalMinor: dto.totalMinor,
      depositAppliedMinor: dto.depositAppliedMinor,
      depositAppliedVatMinor: dto.depositAppliedVatMinor,
      documents: dto.documents.map((d) => ({ type: d.type, number: d.number })),
    });
  }
}
