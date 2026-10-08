import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SeriesRepository } from '../persistence/series.repository';
import { MaterialiseSeriesHandler } from '@application/commands/materialise-series.handler';
import { branchTimeZone, branchToday } from '../persistence/hold.repository';
import { TenantContext } from '../tenancy/tenant-context';

/**
 * The nightly occurrence horizon job: 02:00 branch time.
 *
 * An open-ended series always has about ten weeks of concrete,
 * conflict-checked bookings on the calendar and never an infinite tail. This
 * is what keeps that true.
 *
 * 02:00 because the salon is shut and the diary is quiet. Materialising into
 * a trading day means competing with the desk for the same slots, and losing
 * that race writes a needs-attention item for a clash that would not have
 * existed an hour earlier.
 */
export const MATERIALISE_CRON = '0 2 * * *';

/**
 * How many series one run will touch.
 *
 * A cap rather than everything, because a run that takes an hour is a run
 * that overlaps the salon opening. The index is ordered by how stale the
 * calendar is, so the ones left behind are the freshest and are picked up
 * first tomorrow.
 */
export const MATERIALISE_BATCH = 200;

/**
 * Run each series in its own tenant. OFF unless SERIES_JOB_TENANT=true.
 *
 * WHY. This job has no request, so it has no tenant, and every booking it
 * writes is stamped tenant_id NULL. The staff scope check will refuse a
 * NULL-tenant booking to the salon's own desk, so these have to carry their
 * series' tenant first. The app routine job already books in the routine's
 * own tenant (mobile-series-job.handler.ts, bookFarVisits); this is the same.
 *
 * WHY A FLAG. The tenant is not only stamped on the row. The roster and the
 * catalogue read it too, and with none they fall back to the fixture: today
 * this job plans a real salon's visits against the fixture's stylists and
 * services, and a series sold with a platform service id ends in
 * needs-attention. With the tenant it reads the salon's real stylists and
 * services, so it starts booking visits it used to hand to a human. That is
 * the point, and it is also a change to what lands in the diary at 02:00, so
 * it is switched on deliberately.
 */
export const SERIES_JOB_TENANT = (): boolean =>
  (process.env.SERIES_JOB_TENANT ?? '').trim().toLowerCase() === 'true';

@Injectable()
export class SeriesMaterialiser {
  private static readonly log = new Logger(SeriesMaterialiser.name);
  private running = false;

  constructor(
    private readonly repo: SeriesRepository,
    private readonly handler: MaterialiseSeriesHandler,
    private readonly tenants: TenantContext,
  ) {}

  @Cron(MATERIALISE_CRON, {
    name: 'series-materialise',
    // The one place the zone is read when this module loads, because a
    // decorator cannot wait: in Docker and production BRANCH_TIMEZONE is
    // real process env by then; on a laptop, where .env is loaded later by
    // ConfigModule, this is the default -- 02:00 an hour or two off, on a
    // dev machine, for a job whose point is "while the salon is shut".
    timeZone: branchTimeZone(),
  })
  async nightly(): Promise<void> {
    await this.run();
  }

  /** Exposed so the endpoint and the tests can drive one pass by hand. */
  async run(
    todayOverride?: string,
  ): Promise<{ series: number; materialised: number }> {
    if (this.running) return { series: 0, materialised: 0 };
    this.running = true;

    const today = todayOverride ?? branchToday();
    let series = 0;
    let materialised = 0;

    try {
      const due = await this.repo.dueForTopUp(today, MATERIALISE_BATCH);

      for (const id of due) {
        try {
          const result = await this.inSeriesTenant(id, () =>
            this.handler.run(id, today),
          );
          series += 1;
          materialised += result.materialised;

          if (result.needsAttention > 0) {
            SeriesMaterialiser.log.warn(
              `Series ${id}: ${result.needsAttention} occurrence(s) need attention`,
            );
          }
        } catch (e) {
          // ONE BAD SERIES MUST NOT STOP THE NIGHT. The others still need
          // their calendars, and a run that aborts halfway leaves a
          // fortnight of holes nobody notices until the phone rings.
          SeriesMaterialiser.log.error(
            `Series ${id} failed to materialise: ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (series > 0) {
        SeriesMaterialiser.log.log(
          `Materialised ${materialised} occurrence(s) across ${series} series`,
        );
      }
    } catch (e) {
      SeriesMaterialiser.log.error(
        `Materialiser run failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }

    return { series, materialised };
  }

  /**
   * `fn` inside the series' own tenant, when SERIES_JOB_TENANT is on.
   *
   * A series with no tenant runs with none, exactly as before: it still
   * materialises, and its bookings are stamped NULL as they always were. Off,
   * nothing extra is read and nothing changes.
   */
  private async inSeriesTenant<T>(
    seriesId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!SERIES_JOB_TENANT()) return fn();
    return this.tenants.run(await this.repo.tenantOf(seriesId), fn);
  }
}
