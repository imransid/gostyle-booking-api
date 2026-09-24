import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenVerifier } from './token-verifier.service';
import type { Actor } from './actor';
import { mayWorkTheDesk, deskRefusal } from '@domain/booking/desk-authority';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';

/** Mark an endpoint open to anyone. */
export const PUBLIC_KEY = 'booking:public';

/** Mark an endpoint closed to customers. Set by @DeskOnly(). */
export const DESK_ONLY_KEY = 'booking:desk-only';

export interface RequestWithActor extends Request {
  actor?: Actor;
}

/**
 * The lock on every endpoint.
 *
 * Closed by DEFAULT. A new controller added next month is protected without
 * anyone remembering to protect it; opening one is a deliberate @Public()
 * that shows up in review. The opposite default fails silently and nobody
 * notices until it matters.
 */
@Injectable()
export class BookingAuthGuard implements CanActivate {
  private static readonly log = new Logger(BookingAuthGuard.name);

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
    private readonly tenants: TenantContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const token = bearerFrom(request.headers.authorization);

    if (isPublic === true) {
      if (token !== null) await this.identifyIfPossible(request, token);
      return true;
    }

    if (token === null) {
      throw new UnauthorizedException('Missing bearer token');
    }

    // The verifier throws with a specific reason (expired, invalid, unknown
    // issuer) and those messages are useful, so they are left to propagate
    // rather than flattened into one generic 401.
    const actor = await this.verifier.verify(token);
    this.adopt(request, actor);

    // AFTER the token is verified, so a customer learns they are the wrong
    // KIND of caller rather than that their credential is bad. 403, not 401:
    // signing in again would not help.
    const deskOnly = this.reflector.getAllAndOverride<boolean>(DESK_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (deskOnly === true && !mayWorkTheDesk(actor.kind)) {
      throw new ForbiddenException(deskRefusal(actor.kind));
    }

    return true;
  }

  /**
   * A verified caller, attached the same way on every route, public or not.
   *
   * The earliest point the token's tenant is trustworthy. TenantMiddleware
   * opened the scope with the header alone; this fills it only if the header
   * gave nothing (TenantContext.fillFromToken says why).
   */
  private adopt(request: RequestWithActor, actor: Actor): void {
    request.actor = actor;
    this.tenants.fillFromToken(actor.tenantId);
  }

  /**
   * A public route still READS a token when one is sent.
   *
   * It used to discard it, so a desk user on the new-booking panel -- whose
   * availability calls are @Public() -- reached the engine with no tenant.
   * The platform roster refused a tenant-less lookup, and the panel offered
   * two fixture stylists who do not work at the salon while the guarded
   * calendar drew the three who do.
   *
   * A TOKEN THAT FAILS IS ANONYMOUS HERE, NOT A 401. Expired, forged, unknown
   * issuer, or unverifiable because consumer auth is down (a 503 on a
   * guarded route): the caller carries on exactly as if they had sent
   * nothing, which is what every one of them got before this read tokens at
   * all. Refusing would break the customer app's browsing -- a customer
   * holding a stale token can look at times today -- and the route is public
   * precisely so that a missing credential cannot stop anyone looking. Do
   * not "fix" this into a refusal. The warning is how a bad credential gets
   * noticed instead.
   */
  private async identifyIfPossible(
    request: RequestWithActor,
    token: string,
  ): Promise<void> {
    let actor: Actor;
    try {
      actor = await this.verifier.verify(token);
    } catch (e) {
      BookingAuthGuard.log.warn(
        `Bearer token on public route ${request.method} ${request.path} ` +
          `did not verify ` +
          `(${e instanceof Error ? e.message : String(e)}); serving it ` +
          'anonymously, with no tenant from the token.',
      );
      return;
    }
    this.adopt(request, actor);
  }
}

function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  return value !== undefined && value.length > 0 ? value : null;
}
