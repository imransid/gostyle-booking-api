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
  /** Every service a branch offers, for the customer-facing menu. */
  listServices(
    tenantId: string,
    branchId: string,
    categoryId?: string,
  ): Promise<CatalogueService[]>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const SERVICES_DIRECTORY = Symbol('SERVICES_DIRECTORY');
