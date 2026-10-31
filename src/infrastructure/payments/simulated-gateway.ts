import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CreateIntentInput,
  PaymentGateway,
  PaymentIntent,
  RefundResult,
} from '@application/ports/payment-gateway.port';

/**
 * The webhook secret for local runs and tests (scripts/qa-suite.mjs signs
 * with it). NEVER used where NODE_ENV is production: it is in this
 * repository, so anyone could sign a "payment captured" with it.
 */
export const DEV_WEBHOOK_SECRET = 'simulated-webhook-secret';

/**
 * The secret webhooks are signed with: PAYMENT_WEBHOOK_SECRET, or, outside
 * production only, DEV_WEBHOOK_SECRET. Null in production without one, and
 * then every webhook is refused: fail closed, never open. An empty or
 * blank value counts as unset (an HMAC with an empty key is no secret).
 */
export function webhookSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = (env.PAYMENT_WEBHOOK_SECRET ?? '').trim();
  if (configured !== '') return configured;
  return env.NODE_ENV === 'production' ? null : DEV_WEBHOOK_SECRET;
}

/**
 * A gateway that moves no money.
 *
 * NOT A STOPGAP. The specification asks for a simulate-payment action in the
 * pending panel that "reproduces the gateway webhook so the whole path can be
 * exercised", so this ships: staff can walk a booking from link to confirmed
 * without a card, and the same button is how the flow gets demonstrated and
 * tested long after a real provider is connected.
 *
 * It signs its webhooks properly, with a real HMAC over the raw body, so the
 * verification path is exercised too. A simulator that skipped the signature
 * would leave the one security-relevant piece of this integration untested
 * until the day it went live.
 */
@Injectable()
export class SimulatedGateway implements PaymentGateway, OnModuleInit {
  private static readonly log = new Logger(SimulatedGateway.name);

  onModuleInit(): void {
    if (webhookSecret() === null) {
      SimulatedGateway.log.error(
        'PAYMENT_WEBHOOK_SECRET is not set: every POST /v1/webhooks/payments ' +
          'is refused (401) until it is.',
      );
    }
  }

  createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const intentId = `sim_${randomUUID()}`;
    SimulatedGateway.log.log(
      `Intent ${intentId} for ${input.bookingCode}, ${input.amountFils} fils on ${input.rail}`,
    );
    return Promise.resolve({
      intentId,
      approvalUrl: `/simulate/pay/${intentId}`,
    });
  }

  refund(intentId: string, amountFils: number): Promise<RefundResult> {
    // Always settles. A real gateway does not, which is why RefundResult
    // carries `settled` at all: see the refund_failed path.
    SimulatedGateway.log.log(`Refund ${amountFils} fils against ${intentId}`);
    return Promise.resolve({
      refundId: `simref_${randomUUID()}`,
      settled: true,
    });
  }

  /**
   * A real HMAC over the raw body, compared in constant time.
   *
   * timingSafeEqual rather than ===. A string comparison returns as soon as
   * two bytes differ, and the time it took is a measurable signal about how
   * much of the signature was right. That is a real attack on a real
   * endpoint, and getting it right here costs one function call.
   */
  verifySignature(rawBody: string, signature: string): boolean {
    const secret = webhookSecret();
    if (secret === null) return false;
    const expected = hmac(secret, rawBody);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // timingSafeEqual throws on a length mismatch, which is itself a leak of
    // one bit, but an unavoidable and harmless one.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Exposed so a simulator can sign the webhook it fires. Throws where
   * there is no secret: nothing signs in production without one.
   */
  sign(rawBody: string): string {
    const secret = webhookSecret();
    if (secret === null) {
      throw new Error('PAYMENT_WEBHOOK_SECRET is not set');
    }
    return hmac(secret, rawBody);
  }
}

function hmac(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}
