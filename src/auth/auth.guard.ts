import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided.');
    }

    const token = header.slice('Bearer '.length).trim();
    const identity = await this.auth.verifyToken(token);

    if (identity === null) {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    request.user = identity;

    return true;
  }
}
