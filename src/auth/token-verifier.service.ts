import {
  Injectable,
  Logger,
  type OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthService, type Identity } from './auth.service';
import { Actor, rolesToKind } from './actor';
import { consumerGrpcAddress } from './auth.constants';
import {
  consumerAuthStatusName,
  describeConsumerAuthFailure,
  isConsumerAuthTheirFault,
} from './consumer-auth-failure';
import type { ErrorCode } from '@application/contract/errors';

/** Claims a staff token carries. Issued by gostyle-api (NestJS). */
interface StaffClaims {
  readonly sub: string;
  readonly roles?: readonly string[];
  readonly branchId?: string | null;
  readonly tenantId?: string | null;
  readonly iss?: string;
}

/**
 * Issued by the consumer API (Django SimpleJWT), which sets `aud` where the
 * platform sets `iss`. Different frameworks, different conventions. Both
 * work as a marker because both sit inside the signature.
 */
interface ConsumerClaims {
  readonly consumer_id?: string;
  readonly aud?: string;
}

const STAFF_ISSUER = 'gostyle-api';
const CONSUMER_AUDIENCE = 'gostyle-consumer';

/**
 * The staff signing secret, or null when this service cannot verify at all.
 *
 * One reader, so "unset" and "empty string" mean the same thing everywhere
 * and the boot check and the request path cannot disagree about which it is.
 */
export function staffSecret(
  raw = process.env.JWT_ACCESS_SECRET,
): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

@Injectable()
export class TokenVerifier implements OnModuleInit {
  private static readonly log = new Logger(TokenVerifier.name);

  constructor(private readonly consumerAuth: AuthService) {}

  /**
   * SAID AT BOOT, not once per rejected request.
   *
   * Without this the only symptom of a missing secret is a 401 per call,
   * which reads as "bad token" from both ends: the front end checks its
   * login, and nobody looks at the server. A deploy that drops the variable
   * -- a `docker stack deploy` wipes anything set with `--env-add`, which is
   * exactly how this happens -- now announces itself in the first ten lines
   * of the service log (CLAUDE.md 9).
   */
  onModuleInit(): void {
    if (staffSecret() === null) {
      TokenVerifier.log.error(
        'JWT_ACCESS_SECRET IS NOT SET. Every staff token will be refused ' +
          'with 503 AUTH_MISCONFIGURED until it is, because this service ' +
          'cannot check a signature without it. Set it to the SAME value ' +
          'gostyle-api signs with (HS256, symmetric) and restart.',
      );
    }
  }

  /**
   * One token in, one Actor out, whoever issued it.
   *
   * The token says where it came from, so the CALLER cannot choose which
   * verifier checks them. A header could: send a customer token with
   * X-Client-Type: web and it would be checked against the wrong rules.
   * iss and aud are inside the signature, so changing them breaks the token.
   */
  async verify(token: string): Promise<Actor> {
    // Decoding only READS the text. Nothing is trusted yet; this just picks
    // which key to check against. Verification happens a moment later either
    // way, so a forged marker buys nothing.
    const claims = jwt.decode(token);
    if (claims === null || typeof claims !== 'object') {
      throw new UnauthorizedException('Malformed token');
    }

    const staff = claims as StaffClaims;
    const consumer = claims as ConsumerClaims;

    if (staff.iss === STAFF_ISSUER) return this.verifyStaff(token);
    if (consumer.aud === CONSUMER_AUDIENCE) return this.verifyCustomer(token);

    // Explicit rejection, not a fallback to the customer path. An unknown
    // token sent down the wrong path produces a confusing error instead of
    // a clean 401.
    throw new UnauthorizedException('Unknown token issuer');
  }

  /**
   * Verified LOCALLY, not over the network.
   *
   * A JWT is signed and self-contained: any service holding the key can
   * check it without asking anyone. Calling gostyle-api instead would add a
   * round trip to every request and mean bookings stop while that service
   * restarts.
   *
   * NOTE: the platform signs with HS256, which is symmetric, so this secret
   * can also CREATE staff tokens. Acceptable while both services are ours on
   * one private network. Move the platform to RS256 before any third party
   * verifies these.
   */
  private verifyStaff(token: string): Actor {
    const secret = staffSecret();
    if (secret === null) {
      /**
       * NOT A 401. The caller's token may be perfectly good -- this server
       * simply cannot check it, which is our fault and not theirs.
       *
       * It was `401 UNAUTHENTICATED "Staff authentication unavailable"`, and
       * a client reading the code was told to sign in again. Signing in
       * again produces another token this server still cannot verify, so the
       * loop closes with nobody looking at the one thing that is wrong.
       *
       * The temptation at this point is to skip verification and let the
       * request through. Do not: an unverified staff token is a FORGED staff
       * token, and this guard is the only thing standing between a stranger
       * and every booking in every branch.
       */
      TokenVerifier.log.error(
        'JWT_ACCESS_SECRET is not set; refusing a staff token this service ' +
          'cannot verify.',
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'AUTH_MISCONFIGURED' satisfies ErrorCode,
        message:
          'This server cannot verify staff tokens: its signing secret is not ' +
          'configured. Your token is probably fine. Set JWT_ACCESS_SECRET.',
        details: { variable: 'JWT_ACCESS_SECRET' },
      });
    }

    let claims: StaffClaims;
    try {
      claims = jwt.verify(token, secret, {
        issuer: STAFF_ISSUER,
      }) as StaffClaims;
    } catch (e) {
      // Expired and tampered both land here, and both mean the same thing to
      // the caller: sign in again.
      throw new UnauthorizedException(
        e instanceof jwt.TokenExpiredError ? 'Token expired' : 'Invalid token',
      );
    }

    return {
      id: claims.sub,
      kind: rolesToKind(claims.roles ?? []),
      branchId: claims.branchId ?? null,
      tenantId: claims.tenantId ?? null,
    };
  }

  /**
   * Verified over gRPC, because the answer needs a LOOKUP.
   *
   * The consumer API returns `verified` (phone confirmed), which is not in
   * the token and can change after it was issued. That is a real reason to
   * make a network call, unlike the staff case.
   *
   * Which means this path can fail in a way the staff path cannot: the
   * dependency can be DOWN. That is not the caller's fault and not a bug
   * here, so it must not read as either. Every customer token returned 500
   * while the consumer API refused connections -- a response that says "this
   * service is broken" about a service that was fine, and sends whoever is
   * on call to read this code instead of the network.
   */
  private async verifyCustomer(token: string): Promise<Actor> {
    let identity: Identity | null;
    try {
      identity = await this.consumerAuth.verifyToken(token);
    } catch (e) {
      /**
       * ANYTHING THE DEPENDENCY IS ANSWERABLE FOR IS A 503.
       *
       * This was `isConsumerAuthUnreachable` alone, so an UNKNOWN -- the
       * dependency accepting the call and THEN failing -- fell through as a
       * raw error and became a bare 500 "Something went wrong". Production
       * hit exactly that: the consumer API's own Postgres connection dropped
       * mid-call, and this service reported itself broken for it.
       *
       * A proto skew or a malformed request still rethrows and stays a 500,
       * because those genuinely are ours.
       */
      if (!isConsumerAuthTheirFault(e)) throw e;

      // ERROR on the FIRST failure, with the address, because the whole point
      // of the 503 is that someone can find the box. The status code says
      // "a dependency"; this line says which one and where.
      TokenVerifier.log.error(
        `Consumer auth FAILED at ${consumerGrpcAddress()} -- ` +
          `${describeConsumerAuthFailure(e)}`,
      );
      /**
       * THE CODE IS DECLARED, not left to be inferred.
       *
       * The edge filter falls back to matching the prose when a throw site
       * names no code, and this message contains the word "unavailable" --
       * which the matcher read as a stylist being unavailable and answered
       * BOOKING_STAFF_UNAVAILABLE with a 503. Saying which code this is
       * removes the guess entirely; the status-based rule in inferCode is
       * now the backstop rather than the mechanism.
       */
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE' satisfies ErrorCode,
        message: 'Customer authentication is unavailable',
        details: {
          dependency: 'consumer-auth',
          address: consumerGrpcAddress(),
          // Tells a blip from a structural fault: UNAVAILABLE means nothing
          // answered, UNKNOWN means it answered and then broke.
          grpcStatus: consumerAuthStatusName(e),
        },
      });
    }

    if (identity === null) {
      throw new UnauthorizedException('Invalid token');
    }
    return {
      id: identity.consumerId,
      kind: 'customer',
      branchId: null,
      tenantId: null,
      verified: identity.verified,
    };
  }
}
