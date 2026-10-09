export interface Stylist {
  readonly id: string;
  readonly name: string;
  readonly position: string | null;
  readonly branchId: string | null;
  readonly active: boolean;

  // Presentation fields. All null until platform has columns for them.
  readonly photoUrl: string | null;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly yearsExperience: number | null;
  readonly offday: string | null;
  readonly openingTime: string | null;
  readonly closingTime: string | null;
  readonly bio: string | null;
}

/** A desk member's name, as platform holds it on their staff profile. */
export interface StaffName {
  readonly firstName: string | null;
  readonly lastName: string | null;
}

export type StaffNamesLookup =
  /**
   * Platform answered. Keyed by user id, lower-cased. An id that is not in
   * the map has no staff profile in that tenant (an owner's account, say):
   * that is an answer, and asking again will not change it.
   */
  | {
      readonly kind: 'answered';
      readonly names: ReadonlyMap<string, StaffName>;
    }
  /** NO ANSWER, which is not "no": platform down, slow, or misconfigured. */
  | { readonly kind: 'unavailable'; readonly error: string };

export interface StaffDirectoryReader {
  /** Every stylist at a branch, for the customer-facing list. */
  listStylists(tenantId: string, branchId: string): Promise<Stylist[]>;

  /**
   * The names of these desk members (platform user ids, a token's `sub`),
   * for a screen: who checked a customer in.
   *
   * ONE CALL, however many ids, and each distinct id once.
   *
   * QUICK, ALWAYS: one attempt, at most `quickMs`, no retry, and no log line
   * of its own; the reader writes one per read, if any. A name is
   * decoration: a read must never wait on it, or fail for it.
   *
   * KNOWN COST: platform has no "one staff member by user id", so this asks
   * for the whole tenant's staff (StaffDirectory.ListStylists with no
   * branch) and picks the ids out. It grows with the salon, and it is on a
   * read path. docs/SELF_CHECK_IN_HANDOVER.md has the numbers, and the
   * endpoint this wants.
   */
  namesOf(
    tenantId: string,
    userIds: readonly string[],
    options: { readonly quickMs: number },
  ): Promise<StaffNamesLookup>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const STAFF_DIRECTORY = Symbol('STAFF_DIRECTORY');
