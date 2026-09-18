import { ValidationPipe, type ValidationError } from '@nestjs/common';
import {
  MobileContractError,
  type MobileErrorCode,
  type MobileFieldError,
} from '@application/commands/mobile-booking.error';

/**
 * Field validation, answered in the mobile contract's envelope.
 *
 * WHY THIS EXISTS. The global ValidationPipe throws Nest's 400 with an array
 * of prose messages, which the edge filter then wraps in THIS service's
 * envelope. So `status: "CHECKED_IN"` came back as
 * `{code: "BOOKING_REASON_REQUIRED", message: ["status must be one of..."]}`
 * when booking-create.md §9 promises
 * `{code: "validation_error", errors: [{field: "status", code: "invalid_status"}]}`.
 *
 * The app would have had to parse two different shapes depending on WHICH
 * validation failed -- the DTO's or the handler's -- which is exactly the
 * kind of split nobody discovers until a customer hits the rarer branch.
 *
 * So the pipe maps class-validator's failures onto the contract's own codes.
 * Fields the contract names get their named code; everything else gets
 * `invalid_window`'s sibling, a plain field error, rather than a code the
 * app has never heard of.
 */

/** The contract's per-field codes, for the fields it names (§9). */
const CODE_BY_FIELD: Readonly<Record<string, MobileErrorCode>> = {
  status: 'invalid_status',
  payment_status: 'invalid_payment_status',
  services: 'no_services',
  stylists: 'invalid_stylists',
  date: 'date_mismatch',
  start_time: 'invalid_window',
  end_time: 'invalid_window',
  salon_id: 'not_found',
  amount_without_tax: 'amount_mismatch',
  tax_amount: 'amount_mismatch',
  discount: 'amount_mismatch',
  total: 'amount_mismatch',
  advance_paid_amount: 'amount_mismatch',
  due_amount: 'amount_mismatch',
};

export function mobileValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new MobileContractError(flatten(errors)),
  });
}

/**
 * class-validator nests errors for `@ValidateNested`; the contract's shape
 * is flat. A nested failure reports under its ROOT field, because
 * `services` is the field the app can actually put a cursor in --
 * `services.0.amount` is not something its form knows about.
 */
function flatten(
  errors: readonly ValidationError[],
  root?: string,
): MobileFieldError[] {
  const out: MobileFieldError[] = [];

  for (const e of errors) {
    const field = root ?? e.property;
    const messages = Object.values(e.constraints ?? {});

    if (messages.length > 0) {
      out.push({
        field,
        code: CODE_BY_FIELD[field] ?? 'invalid_window',
        message: messages[0]!,
      });
    }
    if (e.children !== undefined && e.children.length > 0) {
      out.push(...flatten(e.children, field));
    }
  }

  // One error per field. A form highlights a field once, and four messages
  // about the same input read as four separate problems.
  const seen = new Set<string>();
  return out.filter((e) => !seen.has(e.field) && seen.add(e.field));
}
