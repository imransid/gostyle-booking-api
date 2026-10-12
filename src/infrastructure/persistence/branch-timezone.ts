/**
 * The branch's timezone, and the fixed UTC offset every branch-time
 * calculation in this service is built on.
 *
 * FROM `BRANCH_TIMEZONE`, an IANA name. Asia/Dubai when unset: the salons are
 * in the UAE and the money is in dirhams. A test salon elsewhere sets its own
 * (Asia/Dhaka for the Dhaka test salons) instead of the code being edited for
 * it -- which is how the service came to think every branch was in Dhaka.
 *
 * READ ONCE, AT BOOT. Trading days, stored minutes and booking instants all
 * hang off it; changing it while running would put one booking on two days.
 *
 * FIXED-OFFSET ZONES ONLY. Every conversion here is `local = utc + offset`
 * with one offset all year, which is exact for Asia/Dubai (UTC+4) and
 * Asia/Dhaka (UTC+6) and silently wrong for half the year anywhere that
 * observes daylight saving. A DST zone is refused at boot instead: a service
 * that will not start is a configuration fault someone fixes today; a diary
 * an hour out from March to October is one somebody finds in a complaint.
 */

export const DEFAULT_BRANCH_TIMEZONE = 'Asia/Dubai';

/** The configured zone, validated. Throws on an unknown name. */
export function branchTimezone(raw = process.env.BRANCH_TIMEZONE): string {
  const zone = (raw ?? '').trim() || DEFAULT_BRANCH_TIMEZONE;
  try {
    // Throws RangeError for a name the runtime does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(
      `BRANCH_TIMEZONE "${zone}" is not a timezone this runtime knows. ` +
        'Use an IANA name such as Asia/Dubai.',
    );
  }
  return zone;
}

/**
 * The zone's offset from UTC in minutes (Asia/Dubai: 240).
 *
 * Measured in January and in July of `year`; if they differ the zone
 * observes daylight saving and is refused (see above).
 */
export function fixedOffsetMinutes(
  zone: string,
  year = new Date().getUTCFullYear(),
): number {
  const january = offsetAt(zone, Date.UTC(year, 0, 1));
  const july = offsetAt(zone, Date.UTC(year, 6, 1));
  if (january !== july) {
    throw new Error(
      `BRANCH_TIMEZONE "${zone}" observes daylight saving (UTC${fmt(january)} ` +
        `in January, UTC${fmt(july)} in July). Branch time here is a fixed ` +
        'offset all year; a DST zone needs a real timezone library first.',
    );
  }
  return january;
}

/** Minutes east of UTC at one instant, from Intl's "GMT+04:00". */
function offsetAt(zone: string, ms: number): number {
  const name =
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    })
      .formatToParts(ms)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // "GMT" alone is UTC itself.
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (m === null) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

function fmt(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `${sign}${Math.floor(abs / 60)}${abs % 60 === 0 ? '' : `:${String(abs % 60).padStart(2, '0')}`}`;
}
