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

export interface StaffDirectoryReader {
  /** Every stylist at a branch, for the customer-facing list. */
  listStylists(tenantId: string, branchId: string): Promise<Stylist[]>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const STAFF_DIRECTORY = Symbol('STAFF_DIRECTORY');
