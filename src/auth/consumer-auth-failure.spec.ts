import { describe, it, expect } from 'vitest';
import { status } from '@grpc/grpc-js';
import {
  isConsumerAuthUnreachable,
  describeConsumerAuthFailure,
} from './consumer-auth-failure';

/**
 * Every customer token returned 500. The consumer API was refusing
 * connections at 10.0.1.250:50051 and the ECONNREFUSED travelled all the way
 * out as an unhandled error, so the response said "this service is broken"
 * about a service that was fine.
 *
 * This file is the half of the fix that decides WHICH failures get to say
 * "unavailable", because a 503 over a real bug is the same lie pointing the
 * other way.
 */

/** What grpc-js actually throws: an Error with a numeric `code`. */
const grpcError = (code: number, details = ''): Error => {
  const e = new Error(details === '' ? `${code}` : details);
  return Object.assign(e, { code, details });
};

describe('the consumer API is unreachable', () => {
  it('recognises a refused connection', () => {
    const refused = grpcError(
      status.UNAVAILABLE,
      'No connection established (ECONNREFUSED 10.0.1.250:50051)',
    );
    expect(isConsumerAuthUnreachable(refused)).toBe(true);
  });

  it('recognises a call that timed out', () => {
    expect(isConsumerAuthUnreachable(grpcError(status.DEADLINE_EXCEEDED))).toBe(
      true,
    );
  });
});

describe('the consumer API answered, badly', () => {
  it('does not call a missing method an outage', () => {
    // A proto skew between deploys. The server is up; waiting will not fix it.
    expect(isConsumerAuthUnreachable(grpcError(status.UNIMPLEMENTED))).toBe(
      false,
    );
  });

  it('does not call a bad request an outage', () => {
    expect(isConsumerAuthUnreachable(grpcError(status.INVALID_ARGUMENT))).toBe(
      false,
    );
  });

  it('does not call a server-side crash an outage', () => {
    expect(isConsumerAuthUnreachable(grpcError(status.INTERNAL))).toBe(false);
  });
});

describe('errors from our own side of the wire', () => {
  it('an error with no gRPC code is a bug, not an outage', () => {
    expect(isConsumerAuthUnreachable(new Error('client not initialised'))).toBe(
      false,
    );
  });

  it('a non-numeric code is not trusted into meaning anything', () => {
    expect(isConsumerAuthUnreachable({ code: 'UNAVAILABLE' })).toBe(false);
  });

  it('survives whatever was thrown, including nothing', () => {
    expect(isConsumerAuthUnreachable(null)).toBe(false);
    expect(isConsumerAuthUnreachable(undefined)).toBe(false);
    expect(isConsumerAuthUnreachable('ECONNREFUSED')).toBe(false);
  });
});

describe('the line that reaches the log', () => {
  it('names the code and repeats what the server said', () => {
    const line = describeConsumerAuthFailure(
      grpcError(status.UNAVAILABLE, 'ECONNREFUSED 10.0.1.250:50051'),
    );
    expect(line).toBe('UNAVAILABLE: ECONNREFUSED 10.0.1.250:50051');
  });

  it('still says something useful with no details', () => {
    expect(
      describeConsumerAuthFailure(grpcError(status.DEADLINE_EXCEEDED)),
    ).toMatch(/^DEADLINE_EXCEEDED/);
  });

  it('says so when there is no gRPC code at all', () => {
    expect(describeConsumerAuthFailure(new Error('boom'))).toBe(
      'no gRPC code: boom',
    );
  });
});
