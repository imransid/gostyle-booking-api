import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  handleWebhook,
  type WebhookIntent,
  type WebhookOutcome,
} from '@domain/booking/payment-webhook';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '@application/ports/payment-gateway.port';
import { PaymentWebhookRepository } from '@infrastructure/persistence/payment-webhook.repository';

export interface WebhookCommand {
  readonly intent: WebhookIntent;
  readonly bookingCode: string;
}

export interface WebhookView {
  readonly outcome: WebhookOutcome['kind'];
  readonly bookingCode: string;
  readonly explanation: string;
  /** True when this was a retry of something already handled. */
  readonly replayed: boolean;
}

@Injectable()
export class PaymentWebhookHandler {
  private static readonly log = new Logger(PaymentWebhookHandler.name);

  constructor(
    private readonly repo: PaymentWebhookRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * One webhook, one decision, applied once.
   *
   * The domain decides WHAT should happen from the intent and the booking's
   * state; this decides how to carry it out and what to say back. The gateway
   * only ever hears 200, because a non-200 makes it retry, and a retry of
   * something we handled correctly is noise at best.
   */
  async execute(cmd: WebhookCommand): Promise<WebhookView> {
    const state = await this.repo.stateFor(
      cmd.intent.intentId,
      cmd.bookingCode,
    );

    if (state === null) {
      // A webhook for a booking we do not have. Logged and acknowledged: the
      // gateway cannot fix it by retrying, so making it retry helps nobody.
      PaymentWebhookHandler.log.warn(
        `Webhook for unknown booking ${cmd.bookingCode}, acknowledged`,
      );
      return {
        outcome: 'ignored',
        bookingCode: cmd.bookingCode,
        explanation: 'No such booking. Recorded and acknowledged.',
        replayed: false,
      };
    }

    const decision = handleWebhook(cmd.intent, state);

    if (decision.kind === 'already_processed') {
      return {
        outcome: 'already_processed',
        bookingCode: cmd.bookingCode,
        explanation: 'This event was already handled. Nothing changed.',
        replayed: true,
      };
    }

    // Refunds go out through the gateway, and whether they LANDED is the
    // gateway's answer, not ours. The domain already knows a failed refund
    // falls back to the wallet; this is where that actually gets attempted.
    // 'ignored' carries `why` rather than `explanation`, and the compiler is
    // right to insist: two different words for the same idea is exactly the
    // sort of thing that reads fine and returns undefined at runtime.
    let explanation =
      decision.kind === 'ignored' ? decision.why : decision.explanation;

    // A refund is its OWN money movement with its OWN gateway id, not a
    // second row pointing at the payment that preceded it. The ledger has a
    // unique index on gateway_ref precisely to stop two different movements
    // sharing one external reference: reconciling against the gateway later
    // would be ambiguous, and ambiguity in a ledger is the thing it exists
    // to prevent.
    let refundRef: string | undefined;
    if (decision.kind === 'auto_refund') {
      const result = await this.gateway.refund(
        cmd.intent.intentId,
        cmd.intent.amountFils,
      );
      refundRef = result.refundId;
      if (!result.settled) {
        explanation =
          'The refund did not reach the card, so it has been credited to the wallet instead.';
      }
    }

    await this.repo.apply({
      intentId: cmd.intent.intentId,
      bookingCode: cmd.bookingCode,
      kind: decision.kind,
      amountFils: cmd.intent.amountFils,
      rail: cmd.intent.rail,
      explanation,
      ...(refundRef !== undefined ? { refundRef } : {}),
    });

    PaymentWebhookHandler.log.log(
      `${cmd.bookingCode}: ${cmd.intent.kind} -> ${decision.kind}`,
    );

    return {
      outcome: decision.kind,
      bookingCode: cmd.bookingCode,
      explanation,
      replayed: false,
    };
  }
}
