import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/**
 * The mobile group booking routes, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_GROUP_BOOKING=true` turns them on. Read on every
 * request rather than once at boot, the same as PRODUCTS_FROM_PLATFORM, so a
 * test can flip it and a restart is all a deploy needs.
 */
export const MOBILE_GROUP_BOOKING = (): boolean =>
  (process.env.MOBILE_GROUP_BOOKING ?? '').trim().toLowerCase() === 'true';

/** What the deposit is when nothing configures it (decision D1). */
export const DEFAULT_GROUP_DEPOSIT_PERCENT = 20;

/**
 * The percent of a party's total taken as its deposit.
 *
 * THE SERVER'S NUMBER, not the app's. The app sends the percent it offered
 * and it must match this one; the app never chooses how much is held
 * (docs/GROUP_BOOKING_PLAN.md, D1). A value that is not a whole number from
 * 0 to 100 falls back to the default rather than holding a nonsense deposit.
 */
export function groupDepositPercent(
  raw = process.env.MOBILE_GROUP_DEPOSIT_PERCENT,
): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_GROUP_DEPOSIT_PERCENT;
  }
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= 100
    ? n
    : DEFAULT_GROUP_DEPOSIT_PERCENT;
}

/**
 * With the flag off, every route behind this answers 404, the same as a path
 * that does not exist. A 403 or a 422 would announce a feature that is not
 * there.
 *
 * Runs after the global auth guard, so a missing token is still a 401.
 */
@Injectable()
export class MobileGroupEnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (MOBILE_GROUP_BOOKING()) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; path?: string; url: string }>();
    throw new NotFoundException(`Cannot ${req.method} ${req.path ?? req.url}`);
  }
}
