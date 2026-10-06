/**
 * An IANA time zone, reduced to the one number the engine works in.
 *
 * Every trading day and minute-of-day in this service is converted to an
 * instant with a FIXED offset (hold.repository.ts `branchInstant`). That is
 * exact for a zone that never changes its offset -- Asia/Dhaka, Asia/Dubai --
 * and silently wrong twice a year for one that does. So the offset is
 * derived from the zone's own rules, and a zone with daylight saving is
 * refused outright rather than half supported.
 *
 * Pure: Intl only, no clock, no environment.
 */

const MS_PER_MIN = 60_000;

/** Minutes east of UTC that `timeZone` is at the instant `atMs`. */
export function utcOffsetMinutes(timeZone: string, atMs: number): number {
  // Throws RangeError for a zone ICU does not know, which is the right
  // failure: a typo in BRANCH_TIMEZONE must not become UTC.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));

  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);

  const wallClockAsUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  const wholeSecond = atMs - (((atMs % 1000) + 1000) % 1000);
  return Math.round((wallClockAsUtc - wholeSecond) / MS_PER_MIN);
}

/**
 * The zone's offset, provided it is the same all year.
 *
 * Throws for an unknown zone and for one with daylight saving. Both are
 * configuration errors, and both are cheaper to meet at boot than as every
 * booking in March landing an hour out.
 */
export function fixedUtcOffsetMinutes(timeZone: string): number {
  const january = utcOffsetMinutes(timeZone, Date.UTC(2026, 0, 15, 12));
  const july = utcOffsetMinutes(timeZone, Date.UTC(2026, 6, 15, 12));
  if (january !== july) {
    throw new Error(
      `${timeZone} changes its UTC offset during the year ` +
        `(${offsetLabel(january)} in January, ${offsetLabel(july)} in July). ` +
        'The booking engine converts with one fixed offset, so a zone with ' +
        'daylight saving is not supported.',
    );
  }
  return january;
}

/** `UTC+06:00`, for a log line a person reads. */
export function offsetLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}
