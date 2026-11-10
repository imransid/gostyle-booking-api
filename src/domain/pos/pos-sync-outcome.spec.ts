import { describe, it, expect } from 'vitest';
import {
  classifySyncFailure,
  TICKET_NOT_FOUND_RETRIES,
} from './pos-sync-outcome';

const OPEN = { bookingStatus: 'checked_in' as const, attempts: 0 };

describe('classifySyncFailure', () => {
  it.each([
    'UNAVAILABLE',
    'DEADLINE_EXCEEDED',
    'UNKNOWN',
    'INTERNAL',
    'UNAUTHENTICATED',
    'UNIMPLEMENTED',
  ])('retries %s: no verdict, or a setup fault a retry outlives', (s) => {
    expect(
      classifySyncFailure({ grpcStatus: s, errorCode: null }, OPEN),
    ).toEqual({ kind: 'retry' });
  });

  it('retries a failure with no gRPC status at all (a timeout)', () => {
    expect(
      classifySyncFailure({ grpcStatus: null, errorCode: null }, OPEN),
    ).toEqual({ kind: 'retry' });
  });

  it.each([
    ['INVALID_ARGUMENT', null, 'INVALID_ARGUMENT'],
    ['NOT_FOUND', 'POS_BRANCH_NOT_FOUND', 'POS_BRANCH_NOT_FOUND'],
    ['FAILED_PRECONDITION', 'POS_LINE_CATALOG', 'POS_LINE_CATALOG'],
    ['PERMISSION_DENIED', null, 'PERMISSION_DENIED'],
  ])('parks %s (%s) under %s', (grpcStatus, errorCode, code) => {
    expect(classifySyncFailure({ grpcStatus, errorCode }, OPEN)).toEqual({
      kind: 'park',
      code,
    });
  });

  it.each(['POS_Z_IMMUTABLE', 'POS_BRANCH_CLOSED'])(
    'waits for the next trading day on %s',
    (errorCode) => {
      expect(
        classifySyncFailure(
          { grpcStatus: 'FAILED_PRECONDITION', errorCode },
          OPEN,
        ),
      ).toEqual({ kind: 'next_trading_day' });
    },
  );

  it('treats a void with no ticket as done', () => {
    for (const s of ['check_in_undone', 'cancelled', 'no_show'] as const) {
      expect(
        classifySyncFailure(
          {
            grpcStatus: 'NOT_FOUND',
            errorCode: 'POS_BOOKING_TICKET_NOT_FOUND',
          },
          { bookingStatus: s, attempts: 0 },
        ),
      ).toEqual({ kind: 'nothing_to_do' });
    }
  });

  it('gives a status a few tries for its open to land, then parks', () => {
    const f = {
      grpcStatus: 'NOT_FOUND',
      errorCode: 'POS_BOOKING_TICKET_NOT_FOUND',
    };
    expect(
      classifySyncFailure(f, { bookingStatus: 'completed', attempts: 0 }),
    ).toEqual({ kind: 'retry' });
    expect(
      classifySyncFailure(f, {
        bookingStatus: 'completed',
        attempts: TICKET_NOT_FOUND_RETRIES - 1,
      }),
    ).toEqual({ kind: 'park', code: 'POS_BOOKING_TICKET_NOT_FOUND' });
  });

  it('parks a void the till refuses because the ticket was paid', () => {
    expect(
      classifySyncFailure(
        {
          grpcStatus: 'FAILED_PRECONDITION',
          errorCode: 'POS_VOID_AFTER_CAPTURE',
        },
        { bookingStatus: 'cancelled', attempts: 0 },
      ),
    ).toEqual({ kind: 'park', code: 'POS_VOID_AFTER_CAPTURE' });
  });
});
