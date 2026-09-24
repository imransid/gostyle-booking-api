/**
 * The query half of the staff calendar's filters.
 *
 * Pure: strings in, a settled list out. The sibling of booking-list-query.ts,
 * which does the same job for the customer list.
 */

/**
 * A comma-separated query value, read as a list.
 *
 * ONE READER FOR EVERY LIST ON THE CALENDAR. The status chips, the payment
 * chips and the staff and service ids all arrive as `a,b,c`, and the day and
 * week grids each carried their own copy of the split -- four copies before
 * the ids became lists, eight after, had they stayed inline (CLAUDE.md 4).
 *
 * EMPTY IS ABSENT. `""`, `","` and `" "` all mean "no filter", and come back
 * as undefined rather than as an empty list. An empty list reaching the WHERE
 * would match nobody: a cleared filter rendering a blank diary, which is the
 * bug `blankIsAbsent` already fixed at the edge.
 *
 * WHITESPACE AROUND A VALUE IS DROPPED. `maya, reem` is two stylists, not
 * Maya and a stylist called " reem" who matches nothing, silently.
 *
 * Nothing is checked against a vocabulary here. The chips are narrowed by
 * their own guards; an id nobody holds is not an error and simply matches no
 * booking, exactly as a single unknown id always has.
 */
export function commaList(
  raw: string | undefined,
): readonly string[] | undefined {
  const values = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return values.length === 0 ? undefined : values;
}
