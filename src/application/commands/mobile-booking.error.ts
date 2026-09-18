/**
 * The mobile contract's error envelope (§9).
 *
 * DIFFERENT FROM OURS, deliberately. The rest of this service answers
 * `{statusCode, code, message, details, error}`; `booking-create.md` §9
 * answers a `validation_error` carrying a list of FIELD errors, each with
 * its own code and, on a price mismatch, the correct figure:
 *
 *   { detail, code: "validation_error",
 *     errors: [{ field, code, message, expected }] }
 *
 * That shape exists for a reason worth keeping: the app's job on a mismatch
 * is to show the customer what changed, and "prices moved" without the new
 * price is a dead end. So this endpoint speaks the app's envelope rather
 * than making the app learn a second one.
 */

export type MobileErrorCode =
  | 'no_services'
  | 'unknown_service'
  | 'amount_mismatch'
  | 'invalid_promo'
  | 'invalid_status'
  | 'invalid_payment_status'
  | 'invalid_stylists'
  | 'stylist_missing_skill'
  | 'stylist_unavailable'
  | 'date_mismatch'
  | 'invalid_window'
  | 'slot_taken'
  | 'not_found'
  // Ours, for the three parts of the contract this service refuses outright
  // rather than half-supporting.
  | 'products_not_supported'
  | 'routine_not_supported'
  | 'stylist_required'
  // §11
  | 'already_paid'
  | 'deposit_too_low'
  | 'missing_payment_reference'
  | 'booking_expired'
  // booking-list.md §5
  | 'invalid_filter';

export interface MobileFieldError {
  readonly field: string;
  readonly code: MobileErrorCode;
  readonly message: string;
  /** The server's figure, on a price mismatch. Decimal AED. */
  readonly expected?: number;
}

/**
 * Carried, not thrown as an HttpException.
 *
 * The application layer does not know HTTP exists (CLAUDE.md: the layers
 * point one way), so this states the fact and the filter at the edge turns
 * it into a 422.
 */
export class MobileContractError extends Error {
  readonly errors: readonly MobileFieldError[];
  readonly status: number;

  constructor(errors: readonly MobileFieldError[], status = 422) {
    super(errors[0]?.message ?? 'Please correct the highlighted fields.');
    this.name = 'MobileContractError';
    this.errors = errors;
    this.status = status;
  }

  static of(
    field: string,
    code: MobileErrorCode,
    message: string,
    expected?: number,
  ): MobileContractError {
    return new MobileContractError([
      { field, code, message, ...(expected === undefined ? {} : { expected }) },
    ]);
  }

  /**
   * §9: a race, not a mistake.
   *
   * 409 rather than 422 and with its own code, so the app sends the customer
   * back to pick another start instead of showing a validation error against
   * a field they cannot fix.
   */
  static slotTaken(message: string): MobileContractError {
    return new MobileContractError(
      [{ field: 'start_time', code: 'slot_taken', message }],
      409,
    );
  }

  /**
   * §10.1: a booking the caller may not see is 404, never 403.
   *
   * A 403 confirms the id exists, which is precisely what someone
   * enumerating ids wants to learn. "No such booking" and "not yours" have
   * to be indistinguishable from outside.
   */
  static notFoundBooking(): MobileContractError {
    return new MobileContractError(
      [{ field: 'id', code: 'not_found', message: 'No such booking.' }],
      404,
    );
  }

  /** §11.1: only from DRAFT. Refunds and top-ups are their own endpoints. */
  static alreadyPaid(message: string): MobileContractError {
    return new MobileContractError(
      [{ field: 'payment_status', code: 'already_paid', message }],
      409,
    );
  }

  /**
   * booking-list.md §5: `filter` is not one of the three.
   *
   * REFUSED RATHER THAN DEFAULTED. Falling back to `upcoming` for a word
   * nobody recognises is how a client ships a tab that has never once shown
   * what its label claims -- and it would look like it worked.
   */
  static invalidFilter(raw: string): MobileContractError {
    return MobileContractError.of(
      'filter',
      'invalid_filter',
      `filter must be upcoming, recurring or archive. Got "${raw}".`,
    );
  }

  /** §11.7: the draft hold ran out before the gateway answered. */
  static bookingExpired(message: string): MobileContractError {
    return new MobileContractError(
      [{ field: 'id', code: 'booking_expired', message }],
      409,
    );
  }

  static notFound(message: string): MobileContractError {
    return new MobileContractError(
      [{ field: 'salon_id', code: 'not_found', message }],
      404,
    );
  }

  toBody(): Record<string, unknown> {
    return {
      detail:
        this.status === 409
          ? this.message
          : 'Please correct the highlighted fields.',
      code: this.status === 422 ? 'validation_error' : this.errors[0]?.code,
      errors: this.errors,
    };
  }
}

export function isMobileContractError(e: unknown): e is MobileContractError {
  return e instanceof MobileContractError;
}
