/**
 * A string off a proto3 wire, as the port wants it: '' or absent is null.
 *
 * proto3 has no null. An empty string IS the "absent" of every directory
 * that speaks it (staff, customer contact, chairs), and with `defaults` off
 * it arrives as a missing key instead. Both mean the same thing, so both
 * become null. Trimmed, so a stray space is not a value.
 *
 * One copy for every adapter: this was two private ones, and a third was
 * about to be written.
 */
export function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
