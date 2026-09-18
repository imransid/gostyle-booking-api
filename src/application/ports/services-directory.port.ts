export interface CatalogueService {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly durationMinutes: number;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly photoUrls: readonly string[];
  readonly includedSteps: readonly string[];
}

export interface ServicesDirectoryReader {
  /**
   * Every service a branch offers.
   *
   * THROWS rather than answering [] when it could not ask. An empty array
   * means the directory answered and the branch offers nothing; a
   * transport failure is a DEPENDENCY_UNAVAILABLE naming the dependency.
   * Callers must not read an empty result as an outage, or an outage as an
   * empty result -- this answer prices bookings.
   */
  listServices(
    tenantId: string,
    branchId: string,
    categoryId?: string,
  ): Promise<CatalogueService[]>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const SERVICES_DIRECTORY = Symbol('SERVICES_DIRECTORY');
