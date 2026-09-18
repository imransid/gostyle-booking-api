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
  | 'stylist_required';

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
