import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Identity } from './auth.service';
import type { AuthenticatedRequest } from './authenticated-request';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Identity => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Only reachable when the route is missing @UseGuards(AuthGuard).
    // Failing loudly here beats handing a handler an undefined user.
    if (!request.user) {
      throw new UnauthorizedException('No authenticated user on this request.');
    }

    return request.user;
  },
);
