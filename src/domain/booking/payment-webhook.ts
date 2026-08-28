/**
 * What to do when the gateway tells us money moved.
 *
 * A webhook is the only honest source of truth about a payment. The request
 * that started it says what was ASKED for; the webhook says what happened,
 * and those differ often enough that the difference is the whole design.
 */

export type IntentKind =
  'captured' | 'capture_failed' | 'refunded' | 'refund_failed';

export interface WebhookIntent {
  /**
   * The gateway's own id for this payment attempt.
   *
   * THIS IS THE IDEMPOTENCY KEY. Gateways retry, and a retry that charges
   * twice or confirms twice is the worst bug this system could have. Keying
   * on the intent rather than on our own request id means a retry is
   * recognised even when it arrives on a different connection, days later,
   * after a restart.
   */
  readonly intentId: string;
  readonly kind: IntentKind;
  readonly amountFils: number;
  readonly rail: string;
}

/** What we know about the booking when the webhook lands. */
export interface BookingState {
  readonly status: string;
  /** Whether the intent id has already been recorded. */
  readonly alreadySeen: boolean;
  /**
   * For an expired booking: is the slot still free?
   *
   * Answered by the caller, because it needs the availability engine and this
   * file stays pure.
   */
  readonly slotStillFree?: boolean;
}

export type WebhookOutcome =
  /** A retry of something already handled. Return the original answer. */
  | { readonly kind: 'already_processed' }
  /** The ordinary happy path: an unpaid booking becomes confirmed. */
  | { readonly kind: 'confirm'; readonly explanation: string }
  /**
   * The window closed, but nobody took the slot in the meantime.
   *
   * Reinstating is better than refunding: the customer wanted this visit,
   * paid for it, and it is still available. Refusing on a technicality would
   * mean refunding money and losing a booking that could simply happen.
   */
  | { readonly kind: 'reinstate'; readonly explanation: string }
  /**
   * The window closed AND the slot went to someone else.
   *
   * Refund immediately, without being asked. The customer is never left
   * holding a charge against nothing, and a rebook link goes out with fresh
   * offers so the answer is not merely "no".
   */
  | { readonly kind: 'auto_refund'; readonly explanation: string }
  /** Money against a booking that was already paid. Record it, change nothing. */
  | { readonly kind: 'record_only'; readonly explanation: string }
  /** The attempt failed. The booking stays where it is. */
  | { readonly kind: 'capture_failed'; readonly explanation: string }
  /** A refund that actually landed. */
  | { readonly kind: 'refund_settled'; readonly explanation: string }
  /**
   * THE REFUND DID NOT LAND.
   *
   * An expired card, a closed account. The money is still ours and the
   * customer is still owed it, so nothing is marked refunded: the ledger
   * records what HAPPENED, not what was attempted. It falls back to the
   * wallet, and a customer who refuses the wallet becomes a desk task with
   * their contact details rather than a silently unpaid debt.
   */
  | { readonly kind: 'refund_to_wallet'; readonly explanation: string }
  /** Nothing sensible to do. Logged, not applied. */
  | { readonly kind: 'ignored'; readonly why: string };

/** Statuses where money arriving is expected rather than surprising. */
const AWAITING = new Set(['pending_payment', 'pending_confirmation']);
const LIVE = new Set([
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

export function handleWebhook(
  intent: WebhookIntent,
  booking: BookingState,
): WebhookOutcome {
  // Before anything else. A gateway retrying a delivered event must get the
  // original answer, not a second charge and not a second booking.
  if (booking.alreadySeen) return { kind: 'already_processed' };

  switch (intent.kind) {
    case 'captured':
      return captured(booking);

    case 'capture_failed':
      return {
        kind: 'capture_failed',
        explanation:
          'The payment did not go through. The booking is unchanged and the link is still open.',
      };

    case 'refunded':
      return {
        kind: 'refund_settled',
        explanation: 'The refund reached the customer.',
      };

    case 'refund_failed':
      return {
        kind: 'refund_to_wallet',
        explanation:
          'The refund did not reach the card, so it has been credited to the wallet instead. Nothing is marked refunded until money actually moves.',
      };
  }
}

function captured(booking: BookingState): WebhookOutcome {
  if (AWAITING.has(booking.status)) {
    return {
      kind: 'confirm',
      explanation: 'Paid. The booking is confirmed and the pass is issued.',
    };
  }

  if (booking.status === 'expired') {
    // LATE MONEY. The window closed before this arrived.
    return booking.slotStillFree === true
      ? {
          kind: 'reinstate',
          explanation:
            'The link had expired, but the slot was still free. The booking is reinstated and a receipt is on its way.',
        }
      : {
          kind: 'auto_refund',
          explanation:
            'The link expired and the slot went to someone else, so the payment has been refunded in full. A rebook link with fresh times is on its way.',
        };
  }

  if (LIVE.has(booking.status)) {
    return {
      kind: 'record_only',
      explanation: 'Recorded against a booking that was already paid.',
    };
  }

  // Cancelled, no-show: the visit is not happening and the money is not ours.
  return {
    kind: 'auto_refund',
    explanation: `Money arrived against a ${booking.status} booking, so it has been refunded in full.`,
  };
}
