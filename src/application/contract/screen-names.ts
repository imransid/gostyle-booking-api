/**
 * A NAME ON A SCREEN NEVER HOLDS THE SCREEN UP.
 *
 * Shared by every read that puts a person's name beside something this
 * service owns, where the name lives in another service:
 *
 *   the reception list   each customer's name, from customer-api
 *                        (CheckInDeskHandler.named)
 *   the welcome screen   the desk member who checked them in, from platform
 *                        (CheckInAttributionHandler)
 *
 * The read answers whether or not the other service does. A name missing is
 * a cosmetic loss; the read failing, or waiting, is not.
 */

/**
 * Every name lookup of one read, together, gets this long. After it, the
 * read goes out with null for whatever has not come back.
 */
export const SCREEN_NAME_CAP_MS = 1_000;

/**
 * Each lookup's own limit, inside the cap, so a slow service answers
 * "unavailable" (and is counted in the read's one log line) a little before
 * the cap itself fires.
 */
export const SCREEN_NAME_LOOKUP_MS = 900;

/** The work's answer, or null if `ms` passed first. Never rejects for time. */
export async function withinCap<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}
