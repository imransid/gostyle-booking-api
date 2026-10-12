import { describe, it, expect } from 'vitest';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import type {
  SeriesRepository,
  SeriesRow,
} from '@infrastructure/persistence/series.repository';
import type { BookingContextReader } from '@application/ports/booking-context.port';
import type { CustomerContextReader } from '@application/ports/customer-context.port';
import { MaterialiseSeriesHandler } from './materialise-series.handler';

/**
 * THE NIGHTLY RUN HAS NO REQUEST, so nothing told it whose series it was
 * seating, and every booking it wrote had no tenant: invisible to the
 * general ledger, which posts per tenant, and refused by every
 * tenant-scoped catalogue lookup. The series remembers its tenant; the run
 * now works as it.
 */

const SERIES: SeriesRow = {
  id: '0190f0c1-aaaa-7000-8000-000000000001',
  tenantId: 'tenant-of-the-series',
  branchId: 'marina-walk',
  customerId: 'dana',
  startMin: 600,
  autoConfirmRule: 'auto_confirm_on_schedule',
  status: 'active',
  serviceId: 'full-colour',
  preferredStaffId: null,
  baselinePriceFils: 10000,
  grandfathered: false,
  courseTotalNetFils: null,
  courseVisits: null,
  courseDrawn: 0,
  materialisedThrough: null,
};

/** A handler whose repository records the tenant in scope when it is asked. */
function build(series: SeriesRow) {
  const tenants = new TenantContext();
  const seen: (string | null)[] = [];
  const repo = {
    load: () => Promise.resolve(series),
    definition: () => Promise.resolve(null),
    plannedWithin: () => {
      seen.push(tenants.current());
      return Promise.resolve([]);
    },
  } as unknown as SeriesRepository;
  const handler = new MaterialiseSeriesHandler(
    repo,
    {} as BookingContextReader,
    {} as CustomerContextReader,
    tenants,
  );
  return { handler, tenants, seen };
}

describe('MaterialiseSeriesHandler: whose bookings', () => {
  it('outside a request, runs as the series own tenant', async () => {
    const { handler, seen } = build(SERIES);
    await handler.run(SERIES.id, '2026-10-06');
    expect(seen).toEqual(['tenant-of-the-series']);
  });

  it('inside a request that names a tenant, keeps the request tenant', async () => {
    const { handler, tenants, seen } = build(SERIES);
    await tenants.run('tenant-of-the-request', () =>
      handler.run(SERIES.id, '2026-10-06'),
    );
    expect(seen).toEqual(['tenant-of-the-request']);
  });

  it('a series made with no tenant has none to give', async () => {
    const { handler, seen } = build({ ...SERIES, tenantId: null });
    await handler.run(SERIES.id, '2026-10-06');
    expect(seen).toEqual([null]);
  });
});
