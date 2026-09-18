import { describe, it, expect } from 'vitest';
import { status } from '@grpc/grpc-js';
import {
  isRetriable,
  isTransportFailure,
  isUnreachable,
  grpcStatusOf,
  grpcStatusName,
} from './grpc-failure';

const err = (code: number, details = '') => ({ code, details });

/**
 * consumer-auth-failure.spec.ts covers the reporting taxonomy, which this
 * file now implements. What is tested here is the part that is NEW: which
 * failures may be sent again.
 */
describe('isRetriable', () => {
  it('retries UNAVAILABLE, which never reached the server', () => {
    // ECONNRESET on a connection that died while idle arrives as this.
    expect(isRetriable(err(status.UNAVAILABLE, 'read ECONNRESET'))).toBe(true);
  });

  it('does NOT retry DEADLINE_EXCEEDED, even though it reports the same', () => {
    // THE DISTINCTION THAT MATTERS. Both mean "no verdict" to an operator,
    // so they are grouped for reporting. But a deadline says only that WE
    // stopped waiting -- the server may be midway through the work, and
    // sending it again runs it twice.
    const deadline = err(status.DEADLINE_EXCEEDED);
    expect(isUnreachable(deadline)).toBe(true);
    expect(isRetriable(deadline)).toBe(false);
  });

  it('does not retry a fault the server raised while answering', () => {
    // It got the request. Repeating it just breaks it twice.
    for (const c of [status.UNKNOWN, status.INTERNAL, status.DATA_LOSS]) {
      expect(isRetriable(err(c))).toBe(false);
      expect(isTransportFailure(err(c))).toBe(true);
    }
  });

  it('does not retry our own bugs', () => {
    for (const c of [status.UNIMPLEMENTED, status.INVALID_ARGUMENT]) {
      expect(isRetriable(err(c))).toBe(false);
      // And these are not the dependency's fault either, so they must not
      // become a 503 telling an operator to wait for a fix nobody is making.
      expect(isTransportFailure(err(c))).toBe(false);
    }
  });

  it('does not retry an error that never touched gRPC', () => {
    // An rxjs timeout, a client that failed to initialise: ours, and
    // repeating it changes nothing.
    expect(grpcStatusOf(new Error('Timeout has occurred'))).toBeNull();
    expect(isRetriable(new Error('Timeout has occurred'))).toBe(false);
    expect(isTransportFailure(new Error('boom'))).toBe(false);
    expect(grpcStatusName(new Error('boom'))).toBeNull();
  });
});
