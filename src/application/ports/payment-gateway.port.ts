/**
 * Where money actually moves.
 *
 * Deliberately small. A gateway does three things this service cares about:
 * it starts a payment, it sends money back, and it proves that a webhook came
 * from it rather than from anyone who found the URL.
 *
 * Everything else about a provider (their status vocabulary, their retry
 * schedule, their SDK) stops at the adapter. The booking flow never learns
 * which company is processing the card.
 */

export interface CreateIntentInput {
  readonly bookingCode: string;
  readonly amountFils: number;
  readonly currency: 'AED';
  readonly rail: string;
  /** Shown on the customer's statement. */
  readonly description: string;
}

export interface PaymentIntent {
  /**
   * The gateway's id. This becomes the idempotency key for every webhook
   * about this payment, so it has to come from THEM: an id we generated
   * would not be recognisable on a retry that lost our original response.
   */
  readonly intentId: string;
  /** Where to send the customer, for rails that need a page. */
  readonly approvalUrl?: string;
}

export interface RefundResult {
  readonly refundId: string;
  /**
   * Whether the money actually moved.
   *
   * FALSE IS NOT AN ERROR. An expired card or a closed account is an ordinary
   * outcome, and the flow falls back to the wallet rather than pretending the
   * refund happened. Nothing is marked refunded until money actually moves.
   */
  readonly settled: boolean;
  readonly reason?: string;
}

export interface PaymentGateway {
  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;

  refund(intentId: string, amountFils: number): Promise<RefundResult>;

  /**
   * Did this webhook come from the gateway?
   *
   * Takes the RAW body, not the parsed object: every provider signs the exact
   * bytes they sent, and re-serialising JSON changes key order and whitespace,
   * so a signature computed over a parsed-and-restringified body will not
   * match. That is the single most common way this check gets quietly broken.
   */
  verifySignature(rawBody: string, signature: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
