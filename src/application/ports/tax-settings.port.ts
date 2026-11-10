import type { VatPolicy } from '@domain/shared/vat';

/**
 * The tenant's VAT as the platform's till charges it (ServicesDirectory
 * .GetTaxSettings, gostyle-platform docs/booking-pos-tickets-plan.md P13/B9).
 *
 * ALWAYS ANSWERS. With TENANT_VAT_FROM_PLATFORM off, no tenant, a platform
 * that is down, or a tenant with no VAT configured, it answers DEFAULT_VAT
 * (5% exclusive: every figure this service has ever quoted) and says which
 * it was, so a quote is never refused for want of a tax rate.
 */
export interface TaxSettingsAnswer {
  readonly policy: VatPolicy;
  /** Where the policy came from. Only 'platform' is the tenant's own. */
  readonly source: 'platform' | 'default';
}

export interface TaxSettingsReader {
  forTenant(tenantId: string | null): Promise<TaxSettingsAnswer>;
}

export const TAX_SETTINGS = Symbol('TAX_SETTINGS');

/**
 * OFF BY DEFAULT. `TENANT_VAT_FROM_PLATFORM=true` asks the platform for the
 * tenant's rate and mode. Read per call, like the other flags.
 */
export function tenantVatFromPlatform(
  raw = process.env.TENANT_VAT_FROM_PLATFORM,
): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}
