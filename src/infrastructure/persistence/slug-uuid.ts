import { toUuid } from './hold.repository';

/**
 * The slug/uuid boundary, in one place.
 *
 * Ids arrive from the fixture catalogue and roster as slugs ("maya",
 * "full-colour"). The columns are uuid, so writes fold the slug through
 * toUuid. Anything reading an id BACK out therefore holds the hash, and a
 * slug-keyed lookup silently misses.
 *
 * That has now bitten four times in one feature: a Gold customer lost their
 * discount, the waitlist matched nobody, the catalogue lookup failed, and
 * accept asked for a professional who did not exist. Every one silent, every
 * one only visible by running the whole flow.
 *
 * The fix is not another toUuid call at each boundary, because each of those
 * is a place to forget. It is a map that answers to both spellings, built
 * once from the known ids.
 *
 * ALL OF THIS DISAPPEARS when the catalogue and roster speak real uuids.
 */
export class SlugIndex {
  private readonly bySlug = new Map<string, string>();

  constructor(slugs: readonly string[]) {
    for (const slug of slugs) {
      this.bySlug.set(toUuid(slug).toLowerCase(), slug);
    }
  }

  /** A uuid back to its slug, or the input unchanged if it is not one of ours. */
  toSlug(id: string): string {
    return this.bySlug.get(id.toLowerCase()) ?? id;
  }
}
