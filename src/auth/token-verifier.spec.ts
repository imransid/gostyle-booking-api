import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import * as jwt from 'jsonwebtoken';
import { TokenVerifier } from './token-verifier.service';
import type { AuthService, Identity } from './auth.service';

/**
 * Every customer token returned 500 on every endpoint.
 *
 * The consumer API was refusing connections and the ECONNREFUSED travelled
 * out of the guard unhandled, so the API told the caller -- and whoever was
 * paged -- that this service was broken. It was not. The dependency was.
 *
 * What is asserted here is the difference between those two sentences: an
 * outage says 503 and names the box in the log, a bad token still says 401,
 * and a genuine bug is still allowed to be a 500 rather than hiding inside a
 * comfortable "unavailable".
 */

const ADDRESS = '10.0.1.250:50051';
const STAFF_SECRET = 'staff-secret-for-tests';

const customerToken = (): string =>
  jwt.sign({ consumer_id: 'c-1' }, 'not-checked-locally', {
    audience: 'gostyle-consumer',
  });

const staffToken = (): string =>
  jwt.sign({ sub: 's-1', roles: ['stylist'] }, STAFF_SECRET, {
    issuer: 'gostyle-api',
  });

/** grpc-js throws an Error carrying a numeric `code`. */
const grpcError = (code: number, details: string): Error =>
  Object.assign(new Error(details), { code, details });

/** An AuthService that fails the way the real one did. */
const authThatThrows = (e: unknown): AuthService =>
  ({
    // eslint-disable-next-line @typescript-eslint/require-await
    verifyToken: async (): Promise<Identity | null> => {
      throw e;
    },
  }) as unknown as AuthService;

const authThatReturns = (identity: Identity | null): AuthService =>
  ({ verifyToken: () => Promise.resolve(identity) }) as unknown as AuthService;

const refused = grpcError(
  status.UNAVAILABLE,
  `No connection established (ECONNREFUSED ${ADDRESS})`,
);

let logged: string[];

beforeEach(() => {
  process.env.CONSUMER_GRPC_ADDR = ADDRESS;
  process.env.JWT_ACCESS_SECRET = STAFF_SECRET;
  logged = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
    logged.push(String(m));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONSUMER_GRPC_ADDR;
  delete process.env.JWT_ACCESS_SECRET;
});

describe('the consumer API is down', () => {
  it('is a 503, not a 500', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    await expect(verifier.verify(customerToken())).rejects.toMatchObject({
      status: 503,
    });
  });

  it('says it is the dependency, in words an operator can act on', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    await expect(verifier.verify(customerToken())).rejects.toThrow(
      'Customer authentication is unavailable',
    );
  });

  it('is not a 401: signing in again would not help', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    await expect(verifier.verify(customerToken())).rejects.not.toMatchObject({
      status: 401,
    });
  });

  it('logs the address, so the box can be found', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    await expect(verifier.verify(customerToken())).rejects.toThrow();

    // The status code says "a dependency". Only the log says which one.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(ADDRESS);
    expect(logged[0]).toContain('UNAVAILABLE');
  });

  it('logs on the FIRST failure, not after some threshold', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    await expect(verifier.verify(customerToken())).rejects.toThrow();
    expect(logged).toHaveLength(1);
  });

  it('treats a call that timed out the same way', async () => {
    const verifier = new TokenVerifier(
      authThatThrows(grpcError(status.DEADLINE_EXCEEDED, 'Deadline exceeded')),
    );
    await expect(verifier.verify(customerToken())).rejects.toMatchObject({
      status: 503,
    });
  });

  it('leaves staff alone, because staff tokens are verified locally', async () => {
    const verifier = new TokenVerifier(authThatThrows(refused));
    const actor = await verifier.verify(staffToken());
    expect(actor).toMatchObject({ id: 's-1', kind: 'staff' });
  });
});

describe('the consumer API is up', () => {
  it('a rejected token is still a 401', async () => {
    const verifier = new TokenVerifier(authThatReturns(null));
    await expect(verifier.verify(customerToken())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('a good token still becomes a customer', async () => {
    const verifier = new TokenVerifier(
      authThatReturns({ consumerId: 'c-1', verified: true }),
    );
    expect(await verifier.verify(customerToken())).toEqual({
      id: 'c-1',
      kind: 'customer',
      branchId: null,
      tenantId: null,
      verified: true,
    });
  });
});

describe('a failure that is not an outage', () => {
  /**
   * The point of the classifier. A 503 here would tell the operator to wait
   * for a dependency that is already up, while the deploy skew that actually
   * broke it stayed invisible.
   */
  it('a missing method is not dressed up as unavailable', async () => {
    const verifier = new TokenVerifier(
      authThatThrows(grpcError(status.UNIMPLEMENTED, 'VerifyConsumer')),
    );
    await expect(verifier.verify(customerToken())).rejects.not.toMatchObject({
      status: 503,
    });
  });

  it('propagates the original error, stack and all', async () => {
    const bug = new Error('client not initialised');
    const verifier = new TokenVerifier(authThatThrows(bug));
    await expect(verifier.verify(customerToken())).rejects.toBe(bug);
    expect(logged).toEqual([]);
  });
});
