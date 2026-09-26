import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/**
 * The mobile routine (series) routes, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_SERIES_BOOKING=true` turns them on. Read on every
 * request rather than once at boot, the same as MOBILE_GROUP_BOOKING, so a
 * test can flip it and a restart is all a deploy needs.
 *
 * Plan: gostyle-customer-api docs/SERIES_BOOKING_AUDIT.md, E.3.
 */
export const MOBILE_SERIES_BOOKING = (): boolean =>
  (process.env.MOBILE_SERIES_BOOKING ?? '').trim().toLowerCase() === 'true';

/**
 * D9: which no-shows count toward "two in a row pauses the routine" (D5).
 *
 * OFF BY DEFAULT: only a no-show marked by staff counts. The sweeper marks a
 * no-show by itself 30 minutes after the start, and a late customer the desk
 * forgot to check in is not a customer who stayed away. `true` makes the
 * sweeper's own no-shows count as well.
 */
export const ROUTINE_COUNT_AUTO_NO_SHOWS = (): boolean =>
  (process.env.ROUTINE_COUNT_AUTO_NO_SHOWS ?? '').trim().toLowerCase() ===
  'true';

/** The pay as you go deposit when nothing configures it. */
export const DEFAULT_SERIES_DEPOSIT_PERCENT = 20;

/**
 * The percent of each session taken as its deposit under PAY_AS_YOU_GO.
 *
 * THE SERVER'S NUMBER, not the app's, as the group deposit is (group D1). A
 * value that is not a whole number from 0 to 100 falls back to the default
 * rather than showing a nonsense deposit. v1 only shows it (D2).
 */
export function seriesDepositPercent(
  raw = process.env.MOBILE_SERIES_DEPOSIT_PERCENT,
): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SERIES_DEPOSIT_PERCENT;
  }
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= 100
    ? n
    : DEFAULT_SERIES_DEPOSIT_PERCENT;
}

/**
 * With the flag off, every route behind this answers 404, the same as a path
 * that does not exist. A 403 or a 422 would announce a feature that is not
 * there.
 *
 * Runs after the global auth guard, so a missing token is still a 401.
 */
@Injectable()
export class MobileSeriesEnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (MOBILE_SERIES_BOOKING()) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; path?: string; url: string }>();
    throw new NotFoundException(`Cannot ${req.method} ${req.path ?? req.url}`);
  }
}
