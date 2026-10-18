import { Inject, Injectable, Logger } from '@nestjs/common';
import { PlatformPackageCatalogue } from '@infrastructure/persistence/platform-package-catalogue';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { expandPackage } from '@domain/booking/package';
import { priceOfService } from '@domain/booking/service-resolution';
import { filsToAed } from '@domain/booking/mobile-contract';
import { priceOf } from '@application/commands/confirm-booking.handler';

/**
 * The packages a salon sells, for the app's picker.
 *
 * A BROKEN PACKAGE IS SKIPPED, NOT FATAL. One package priced above its parts
 * (or with a part the catalogue cannot find) must not empty the whole list;
 * it is logged and left out. The ids returned here are exactly what the app
 * sends back in `services[].id` on create, with `amount` = `price`... see
 * the note on amount below.
 */
@Injectable()
export class MobilePackagesHandler {
  private static readonly log = new Logger(MobilePackagesHandler.name);

  constructor(
    private readonly packages: PlatformPackageCatalogue,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async list(salonId: string): Promise<{
    count: number;
    results: readonly Record<string, unknown>[];
  }> {
    const all = await this.packages.forBranch(salonId);
    const results: Record<string, unknown>[] = [];

    for (const pkg of all) {
      try {
        const unique = [...new Set(pkg.serviceIds)];
        const found = await this.context.loadServices(salonId, unique);
        const byId = new Map(found.map((s) => [s.id, s]));
        const missing = unique.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new Error(`parts not found: ${missing.join(', ')}`);
        }

        const priceFor = (id: string): number => {
          const s = byId.get(id);
          return s === undefined ? 0 : priceOfService(s, priceOf);
        };
        const expansion = expandPackage(pkg, priceFor);

        const parts = pkg.serviceIds.map((id) => byId.get(id)!);
        results.push({
          id: pkg.id,
          name: pkg.name,
          // Net of VAT, like every services[].amount the app already sees.
          amount_without_tax: filsToAed(expansion.packagePriceFils),
          parts_total: filsToAed(expansion.partsTotalFils),
          savings: filsToAed(expansion.bundleDiscountFils),
          // Sum of the parts. The create's quote stays the authority on the
          // real visit length; treat this as a guide for the picker.
          duration_min: parts.reduce((n, s) => n + s.durationMin, 0),
          services: parts.map((s) => ({
            id: s.id,
            name: s.name,
            amount: filsToAed(priceFor(s.id)),
          })),
        });
      } catch (e) {
        MobilePackagesHandler.log.warn(
          `package ${pkg.id} left out of the list: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return { count: results.length, results };
  }
}
