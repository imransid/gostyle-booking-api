import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SERVICES_DIRECTORY,
  type CatalogueService,
  type ServicesDirectoryReader,
} from '@application/ports/services-directory.port';
import { TenantContext } from '../tenancy/tenant-context';
import { bookingError } from '@application/contract/errors';
import type { Service } from '@domain/availability/feasible';
import {
  looksLikePlatformId,
  oneCurrency,
  sourceOf,
} from '@domain/booking/service-resolution';

/**
 * Stage 1 of the slug-to-UUID migration: services from platform, slugs still
 * accepted.
 *
 * WHAT THIS IS FOR. `BookingContextReader.loadServices` has always answered
 * from a hard-coded fixture of thirteen slugs. The mobile app now sends real
 * platform uuids, which resolve to nothing, so every booking is refused.
 * This resolves a uuid from platform and leaves everything else on the
 * fixture, so both work at once and we can see who is still sending slugs
 * before stage 2 removes them.
 *
 * OFF BY DEFAULT. `SERVICES_FROM_PLATFORM=true` turns it on. With the flag
 * off nothing changes at all: the fixture answers, exactly as before.
 *
 * WHAT IT DOES NOT TOUCH. Skills, shifts and chairs stay on the fixture.
 * Those need data platform does not expose yet (see
 * docs/api/PLATFORM-ASKS-BOOKING-CONTEXT.md), and swapping one of them
 * halfway would be worse than not swapping it.
 */

export const SERVICES_FROM_PLATFORM = (): boolean =>
  (process.env.SERVICES_FROM_PLATFORM ?? '').trim().toLowerCase() === 'true';

/**
 * Platform services carry no usable skill yet, so eligibility cannot be
 * checked for them. Acknowledging that is a SECOND, explicit flag.
 *
 * WHY NOT JUST DEFAULT IT. A service with an empty skill and a required
 * level of zero passes `eligible()` for every professional -- the engine
 * reads it as "no skill required" and offers a trainee for a balayage. That
 * is the single unsafe direction in this whole migration, and it would
 * arrive silently the moment the first flag went on.
 *
 * So: platform resolution requires BOTH flags, and every booking it touches
 * says so in the log. The flag comes off when the two skill vocabularies are
 * reconciled (ask A2).
 */
export const SKILLS_UNVERIFIED = (): boolean =>
  (process.env.SKILLS_UNVERIFIED ?? '').trim().toLowerCase() === 'true';

/** Which catalogue answered for each id. Measured, so stage 2 is informed. */
export interface ResolutionTally {
  readonly platform: readonly string[];
  readonly fixture: readonly string[];
  readonly unresolved: readonly string[];
}

@Injectable()
export class PlatformServiceCatalogue {
  private static readonly log = new Logger(PlatformServiceCatalogue.name);

  constructor(
    @Inject(SERVICES_DIRECTORY)
    private readonly directory: ServicesDirectoryReader,
    private readonly tenants: TenantContext,
  ) {}

  /** Nothing to do unless both flags are on. */
  enabled(): boolean {
    return SERVICES_FROM_PLATFORM();
  }

  /**
   * Resolve the ids that look like platform uuids.
   *
   * Returns only what platform knew. The caller fills the rest from the
   * fixture, which is what keeps slugs working.
   */
  async resolve(
    branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]> {
    const wanted = serviceIds.filter(looksLikePlatformId);
    if (wanted.length === 0) return [];

    const tenantId = this.tenants.current();
    if (tenantId === null) {
      /**
       * NO TENANT, NO LOOKUP. ListServices is tenant-scoped, and guessing
       * one would either fail or -- worse -- succeed against somebody
       * else's catalogue. Rule 2: this removes availability rather than
       * inventing it.
       */
      PlatformServiceCatalogue.log.warn(
        `Cannot resolve ${wanted.length} platform service(s): no X-Tenant-Id ` +
          'on this request, and ListServices is tenant-scoped.',
      );
      return [];
    }

    // list-by-branch is all platform offers today (ask B4), so the whole
    // catalogue comes back and we pick from it.
    const catalogue = await this.directory.listServices(tenantId, branchId);

    /**
     * ONE ROW PER SERVICE, OR WE DO NOT KNOW THE PRICE.
     *
     * `service_stage` holds several rows per service, and if ListServices
     * ever returns one row per STAGE then a Map keyed on service_id keeps
     * whichever arrived last -- silently pricing a whole visit at one
     * stage's cost. That is indistinguishable from a correct answer at every
     * layer above this one, and it ends up in booking_item.price_fils.
     *
     * Detected rather than assumed away, because the alternative is charging
     * the wrong number and finding out from a customer.
     */
    const seen = new Map<string, number>();
    for (const c of catalogue) {
      const key = c.id.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    if (duplicated.length > 0) {
      PlatformServiceCatalogue.log.error(
        `ListServices returned MULTIPLE rows for [${duplicated.join(',')}] at ` +
          `branch ${branchId}. A price read from one of them is a guess; ` +
          'refusing rather than charging it.',
      );
      throw bookingError(
        'BOOKING_STATE_INVALID',
        'The service catalogue returned more than one row for a service, so ' +
          'its price is ambiguous.',
        { services: duplicated },
      );
    }

    const byId = new Map(catalogue.map((c) => [c.id.toLowerCase(), c]));

    const found: Service[] = [];
    for (const id of wanted) {
      const row = byId.get(id.toLowerCase());
      if (row === undefined) continue;

      /**
       * WHAT THE WIRE ACTUALLY SAID, for every service we are about to
       * charge for.
       *
       * A booking was written at price_fils=1200 while ListServices reported
       * price_minor=12000 for the same id -- a factor of ten, with no
       * arithmetic anywhere between the two (the value passes untouched from
       * `price_minor` through `priceMinor`, `priceFils`, `serviceFils` and
       * `subtotalNetFils`). So the number must arrive wrong, and the only
       * way to tell is to print it at the boundary where it lands.
       *
       * Logged at INFO with the neighbouring fields, because a proto skew
       * garbles everything AFTER the shifted field: if the name and duration
       * are right and only the price is wrong, it is not skew.
       */
      PlatformServiceCatalogue.log.log(
        `wire service=${row.id} name="${row.name}" ` +
          `price_minor=${row.priceMinor} (${typeof row.priceMinor}) ` +
          `currency=${row.currency} duration=${row.durationMinutes}`,
      );

      if (!Number.isInteger(row.priceMinor) || row.priceMinor <= 0) {
        /**
         * A price that is not a positive whole minor unit is not a price.
         * Zero is the AED 0.00 bug in another form, and a fraction means the
         * field is not what the proto says it is.
         */
        PlatformServiceCatalogue.log.error(
          `Refusing ${row.id}: price_minor=${JSON.stringify(row.priceMinor)} ` +
            'is not a positive whole minor unit.',
        );
        throw bookingError(
          'BOOKING_STATE_INVALID',
          'That service has no usable price in the catalogue.',
          { service: row.id, priceMinor: row.priceMinor },
        );
      }

      found.push(toEngineService(row));
    }

    if (found.length < wanted.length && catalogue.length === 0) {
      /**
       * An empty catalogue now means EMPTY.
       *
       * It used to be ambiguous: the adapter swallowed its own errors and
       * returned [], so "platform is down" and "this branch sells nothing"
       * arrived here identically, and a customer was told `unknown_service`
       * either way. The adapter refuses a transport failure now, so
       * reaching this line means platform answered and had nothing to say.
       *
       * Still worth a warning -- a branch that sells nothing is usually a
       * misconfigured branch id, not a real one.
       */
      PlatformServiceCatalogue.log.warn(
        `Platform answered with an EMPTY catalogue for branch ${branchId}. ` +
          'The call succeeded, so this branch genuinely offers no services ' +
          '-- most often a branch id that does not exist upstream.',
      );
    }

    return found;
  }

  /**
   * Say where each service came from, and refuse a basket we cannot price.
   *
   * Called once per resolution with everything that was found, from both
   * catalogues.
   */
  report(
    branchId: string,
    asked: readonly string[],
    resolved: readonly Service[],
  ): ResolutionTally {
    const byId = new Map(resolved.map((s) => [s.id, s]));

    const platform: string[] = [];
    const fixture: string[] = [];
    const unresolved: string[] = [];

    for (const id of asked) {
      const s = byId.get(id);
      if (s === undefined) unresolved.push(id);
      // Was `s.priceFils !== undefined`, which was only ever right by
      // coincidence -- the fixture happens to carry no prices. sourceOf
      // reads what the resolver recorded.
      else if (sourceOf(s) === 'platform') platform.push(id);
      else fixture.push(id);
    }

    /**
     * THE MEASUREMENT STAGE 2 NEEDS.
     *
     * Stage 2 removes slug support. Before doing that we need to know who is
     * still sending them, and the only way to know is to count. One line per
     * resolution, at INFO, naming both sides.
     */
    PlatformServiceCatalogue.log.log(
      `resolved branch=${branchId} ` +
        `platform=[${platform.join(',')}] ` +
        `fixture=[${fixture.join(',')}] ` +
        `unresolved=[${unresolved.join(',')}]`,
    );

    if (platform.length > 0 && !SKILLS_UNVERIFIED()) {
      /**
       * Refused rather than silently skill-free. See SKILLS_UNVERIFIED.
       */
      throw bookingError(
        'BOOKING_SKILL_MISSING',
        'Platform services carry no skill yet, so nobody can be shown to be ' +
          'qualified for them. Set SKILLS_UNVERIFIED=true to book anyway, ' +
          'which treats every professional as qualified and logs it.',
        { services: platform, flag: 'SKILLS_UNVERIFIED' },
      );
    }

    if (platform.length > 0) {
      PlatformServiceCatalogue.log.warn(
        `SKILLS_UNVERIFIED: eligibility NOT checked for [${platform.join(',')}] ` +
          '-- every professional is treated as qualified.',
      );
    }

    // ONE CURRENCY PER BASKET. Production has BDT and AED services at the
    // same branch, and price_fils is one integer with no currency beside it.
    const verdict = oneCurrency(resolved);
    if (verdict.kind === 'mixed') {
      throw bookingError(
        'BOOKING_CURRENCY_MIXED',
        `This basket mixes ${verdict.currencies.join(' and ')}. Prices in ` +
          'different currencies cannot be added, and there is no rate to ' +
          'convert them with.',
        { currencies: verdict.currencies },
      );
    }

    return { platform, fixture, unresolved };
  }
}

/**
 * A platform service, as the engine needs it.
 *
 * FOUR OF ELEVEN FIELDS ARE REAL. The rest are stubs, and each one is a
 * named ask in docs/api/PLATFORM-ASKS-BOOKING-CONTEXT.md. They are set to
 * the value that OVER-reserves rather than under-reserves, so a wrong guess
 * costs the salon capacity rather than costing a customer their slot:
 *
 *   skill / requiredLevel   '' and 0 -- no requirement, gated behind
 *                           SKILLS_UNVERIFIED because it is the one stub
 *                           that is unsafe rather than merely wasteful (A1/A2)
 *   resourceType            'styling' -- one shared pool. Wrong, and the
 *                           least-bad wrong: a single pool over-counts
 *                           contention rather than overbooking a chair (B1)
 *   claims                  no buffers -- back-to-back with no turnaround (B2)
 *   processing              absent -- the professional is held for the whole
 *                           service instead of released mid-development,
 *                           which costs sellable hours and sells nothing
 *                           twice (B2)
 *   deposit                 absent -- rung 3 of the ladder stays silent (B3)
 */
function toEngineService(row: CatalogueService): Service {
  return {
    id: row.id,
    name: row.name,
    durationMin: row.durationMinutes,
    priceFils: row.priceMinor,
    currency: row.currency,

    // Stamped at the only place that knows. Everything downstream carries
    // this rather than guessing from the shape of the row.
    source: 'platform',

    skill: '',
    requiredLevel: 0,
    resourceType: 'styling',
    claims: { preMin: 0, postMin: 0 },
  };
}
