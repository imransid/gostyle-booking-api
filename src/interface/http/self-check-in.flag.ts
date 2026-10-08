import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/**
 * The self check-in routes, on or off.
 *
 * OFF BY DEFAULT. `SELF_CHECK_IN_V1=true` turns them on; anything else,
 * a typo included, is off. Read on every request rather than once at boot,
 * the same as MOBILE_SERIES_BOOKING, so a test can flip it and a restart is
 * all a deploy needs.
 *
 * Only the ROUTES. The auto no-show sweeper's check and the lapse job run
 * whatever this says: with no requests they do nothing, and with the flag
 * switched off mid-day the requests already waiting still end properly.
 */
export const SELF_CHECK_IN_V1 = (): boolean =>
  (process.env.SELF_CHECK_IN_V1 ?? '').trim().toLowerCase() === 'true';

/**
 * With the flag off, every route behind this answers 404, the same as a path
 * that does not exist. A 403 or a 422 would announce a feature that is not
 * there.
 *
 * Runs after the global auth guard, so a missing token is still a 401.
 */
@Injectable()
export class SelfCheckInEnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (SELF_CHECK_IN_V1()) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; path?: string; url: string }>();
    throw new NotFoundException(`Cannot ${req.method} ${req.path ?? req.url}`);
  }
}
