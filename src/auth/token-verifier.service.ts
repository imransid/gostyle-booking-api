import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthService, type Identity } from './auth.service';
import { Actor, rolesToKind } from './actor';
import { consumerGrpcAddress } from './auth.constants';
import {
  describeConsumerAuthFailure,
  isConsumerAuthUnreachable,
} from './consumer-auth-failure';

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

@Injectable()
export class TokenVerifier {
  private static readonly log = new Logger(TokenVerifier.name);

  constructor(private readonly consumerAuth: AuthService) {}

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
    const secret = process.env.JWT_ACCESS_SECRET;
    if (secret === undefined || secret === '') {
      TokenVerifier.log.error('JWT_ACCESS_SECRET is not set');
      throw new UnauthorizedException('Staff authentication unavailable');
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
      // Only the codes that mean the answer never arrived. A 503 over a real
      // bug -- a proto skew, a malformed request -- is the same lie pointing
      // the other way, and tells the operator to wait for a recovery that is
      // not coming. Those rethrow, keep their stack and stay a 500.
      if (!isConsumerAuthUnreachable(e)) throw e;

      // ERROR on the FIRST failure, with the address, because the whole point
      // of the 503 is that someone can find the box. The status code says
      // "a dependency"; this line says which one and where.
      TokenVerifier.log.error(
        `Consumer API unreachable at ${consumerGrpcAddress()} -- ` +
          `${describeConsumerAuthFailure(e)}`,
      );
      throw new ServiceUnavailableException(
        'Customer authentication is unavailable',
      );
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
