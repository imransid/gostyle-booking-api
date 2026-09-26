import { describe, expect, it } from 'vitest';
import {
  MobileContractError,
  type MobileErrorCode,
} from './mobile-booking.error';
import {
  SERIES_REFUSAL_CODES,
  refusalStatus,
} from '@domain/booking/mobile-series-contract';

/**
 * Every routine refusal comes out in the app's envelope (booking-create.md
 * §9), with the status the contract gives it.
 *
 * The assignment below is the real test that each code is a MobileErrorCode:
 * `pnpm typecheck` fails if the contract grows a code this union lacks.
 */
const CODES: readonly MobileErrorCode[] = SERIES_REFUSAL_CODES;

describe('routine refusals in the mobile envelope', () => {
  it('lists every code', () => {
    expect(CODES).toHaveLength(SERIES_REFUSAL_CODES.length);
  });

  it.each(SERIES_REFUSAL_CODES.map((c) => [c] as const))('%s', (code) => {
    const status = refusalStatus(code);
    const error = new MobileContractError(
      [{ field: 'x', code, message: 'Because.' }],
      status,
    );
    const body = error.toBody();

    expect(error.status).toBe(status);
    expect(body.errors).toEqual([{ field: 'x', code, message: 'Because.' }]);
    // 422 is a validation_error; 409 and 404 name their own code.
    expect(body.code).toBe(status === 422 ? 'validation_error' : code);
  });

  it('amount_mismatch carries the server figure', () => {
    const body = MobileContractError.of(
      'total',
      'amount_mismatch',
      'Prices changed since this routine was started.',
      210,
    ).toBody();
    expect(body.errors).toEqual([
      {
        field: 'total',
        code: 'amount_mismatch',
        message: 'Prices changed since this routine was started.',
        expected: 210,
      },
    ]);
  });
});
