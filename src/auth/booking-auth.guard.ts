import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenVerifier } from './token-verifier.service';
import type { Actor } from './actor';

/** Mark an endpoint open to anyone. */
export const PUBLIC_KEY = 'booking:public';

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
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const token = bearerFrom(request.headers.authorization);
    if (token === null) {
      throw new UnauthorizedException('Missing bearer token');
    }

    // The verifier throws with a specific reason (expired, invalid, unknown
    // issuer) and those messages are useful, so they are left to propagate
    // rather than flattened into one generic 401.
    request.actor = await this.verifier.verify(token);
    return true;
  }
}

function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  return value !== undefined && value.length > 0 ? value : null;
}
