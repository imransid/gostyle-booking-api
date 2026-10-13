import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/**
 * The group check-in routes, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_CHECK_IN=true` turns them on; anything else,
 * a typo included, is off. Read on every request rather than once at boot,
 * the same as SELF_CHECK_IN_V1, so a test can flip it and a restart is all a
 * deploy needs.
 *
 * Only this one switch. The group check-in route also sits behind the self
 * check-in guard (self-check-in.flag.ts) and the mobile group guard
 * (mobile-group.flag.ts): all three must be on.
 */
export const MOBILE_GROUP_CHECK_IN = (): boolean =>
  (process.env.MOBILE_GROUP_CHECK_IN ?? '').trim().toLowerCase() === 'true';

/**
 * With the flag off, every route behind this answers 404, the same as a path
 * that does not exist. A 403 or a 422 would announce a feature that is not
 * there.
 *
 * Runs after the global auth guard, so a missing token is still a 401.
 */
@Injectable()
export class MobileGroupCheckInEnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (MOBILE_GROUP_CHECK_IN()) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; path?: string; url: string }>();
    throw new NotFoundException(`Cannot ${req.method} ${req.path ?? req.url}`);
  }
}
