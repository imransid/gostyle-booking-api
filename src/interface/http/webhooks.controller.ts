import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import {
  PaymentWebhookHandler,
  type WebhookView,
} from '@application/commands/payment-webhook.handler';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '@application/ports/payment-gateway.port';
import { unshout } from '@application/contract/wire';
import { Public } from '../../auth/public.decorator';
import type { IntentKind } from '@domain/booking/payment-webhook';

const INTENT_KINDS = [
  'captured',
  'capture_failed',
  'refunded',
  'refund_failed',
] as const;

export class PaymentWebhookDto {
  @ApiProperty({ example: 'sim_9f2c...' })
  @IsString()
  intentId!: string;

  @ApiProperty({ example: 'GS-1009' })
  @IsString()
  bookingCode!: string;

  @ApiProperty({
    enum: ['CAPTURED', 'CAPTURE_FAILED', 'REFUNDED', 'REFUND_FAILED'],
  })
  @WireEnum(['CAPTURED', 'CAPTURE_FAILED', 'REFUNDED', 'REFUND_FAILED'])
  kind!: Uppercase<IntentKind>;

  @ApiProperty({ example: 24000 })
  @IsInt()
  @Min(0)
  amountMinor!: number;

  @ApiProperty({ example: 'card' })
  @IsString()
  rail!: string;
}

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly handler: PaymentWebhookHandler,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Where the gateway tells us money moved.
   *
   * PUBLIC ON PURPOSE. A gateway has no bearer token and no session; the
   * SIGNATURE is the authentication. Requiring a token here would mean
   * sharing a long-lived credential with a third party, which is strictly
   * worse than an HMAC over the exact bytes they sent.
   *
   * Always 200, even for a booking we do not recognise. A non-200 makes the
   * gateway retry, and retrying will not conjure up a booking that does not
   * exist: it just turns one confusing event into thousands.
   */
  @Post('payments')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Gateway intent lifecycle',
    description:
      'Signed, and idempotent by intent id. A retry of a delivered event ' +
      'returns the original result: no second charge, no second booking.',
  })
  @ApiHeader({
    name: 'x-signature',
    description: 'HMAC-SHA256 over the raw body.',
  })
  @ApiOkResponse({ description: 'Handled, or recognised as a retry.' })
  @ApiUnauthorizedResponse({ description: 'The signature did not verify.' })
  payments(
    @Body() dto: PaymentWebhookDto,
    @Headers('x-signature') signature: string | undefined,
    @Req() req: { rawBody?: Buffer },
  ): Promise<WebhookView> {
    // The RAW bytes, not the parsed body re-serialised. JSON round-tripping
    // changes key order and whitespace, so a signature checked against the
    // re-serialised form never matches.
    const raw = req.rawBody?.toString('utf8');

    if (
      raw === undefined ||
      signature === undefined ||
      !this.gateway.verifySignature(raw, signature)
    ) {
      // Deliberately vague. Telling an unsigned caller WHY it failed helps
      // them iterate towards a signature that works.
      throw new UnauthorizedException('Signature verification failed.');
    }

    return this.handler.execute({
      intent: {
        intentId: dto.intentId,
        kind: unshout(dto.kind, INTENT_KINDS)!,
        amountFils: dto.amountMinor,
        rail: dto.rail,
      },
      bookingCode: dto.bookingCode,
    });
  }
}
