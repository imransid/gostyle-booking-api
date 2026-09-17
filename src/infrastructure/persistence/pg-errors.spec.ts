import { describe, it, expect } from 'vitest';
import {
  isExclusionViolation,
  isUniqueViolationOn,
  uniqueViolationFields,
} from './pg-errors';

/**
 * The fixtures below are COPIED OFF REAL FAILURES, not written from the
 * documentation. That is the whole point of this file: the shape Prisma 7
 * reports through the pg driver adapter is three levels deep and nothing
 * checks it at compile time, so a plausible-looking guess passes review and
 * then silently matches nothing in production.
 */

/** POST /v1/bookings twice with one gateway ref, captured 2026-09-17. */
const duplicateGatewayRef = {
  code: 'P2002',
  meta: {
    modelName: 'DepositLedger',
    driverAdapterError: {
      cause: {
        originalCode: '23505',
        originalMessage:
          'duplicate key value violates unique constraint "deposit_ledger_gateway_ref_key"',
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['gateway_ref'] },
      },
    },
  },
};

/** The same class of error on the OTHER unique index in the confirm path. */
const duplicateIdempotencyKey = {
  code: 'P2002',
  meta: {
    modelName: 'IdempotencyKey',
    driverAdapterError: {
      cause: {
        originalCode: '23505',
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['key'] },
      },
    },
  },
};

/** Two desks reaching for one professional. Already handled elsewhere. */
const exclusion = {
  code: 'P2039',
  meta: { driverAdapterError: { cause: { code: '23P01' } } },
};

describe('isUniqueViolationOn', () => {
  it('names the column a duplicate gateway ref violated', () => {
    expect(isUniqueViolationOn(duplicateGatewayRef, 'gateway_ref')).toBe(true);
  });

  /**
   * THE REASON THE FUNCTION TAKES A FIELD AT ALL. Both errors are P2002 in
   * the same catch block, and only the gateway one is a refusal: a duplicate
   * key means a retry raced us and must replay the original booking. Matching
   * P2002 alone would turn every retry into a 409.
   */
  it('does not match a duplicate idempotency key', () => {
    expect(isUniqueViolationOn(duplicateIdempotencyKey, 'gateway_ref')).toBe(
      false,
    );
    expect(isUniqueViolationOn(duplicateIdempotencyKey, 'key')).toBe(true);
  });

  it('does not match an exclusion violation', () => {
    expect(isUniqueViolationOn(exclusion, 'gateway_ref')).toBe(false);
  });

  it('reads the classic meta.target spelling, list or bare string', () => {
    const listed = { code: 'P2002', meta: { target: ['gateway_ref'] } };
    const named = { code: 'P2002', meta: { target: 'gateway_ref' } };
    expect(isUniqueViolationOn(listed, 'gateway_ref')).toBe(true);
    expect(isUniqueViolationOn(named, 'gateway_ref')).toBe(true);
  });

  it('survives anything that is not an error object', () => {
    for (const junk of [null, undefined, 'boom', 42, {}, { meta: null }]) {
      expect(uniqueViolationFields(junk)).toEqual([]);
      expect(isUniqueViolationOn(junk, 'gateway_ref')).toBe(false);
    }
  });
});

describe('isExclusionViolation, still', () => {
  it('matches the nested driver adapter shape', () => {
    expect(isExclusionViolation(exclusion)).toBe(true);
  });

  it('does not match a unique violation', () => {
    expect(isExclusionViolation(duplicateGatewayRef)).toBe(false);
  });
});
