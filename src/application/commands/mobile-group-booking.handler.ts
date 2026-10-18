import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { GroupHoldHandler, type GroupHoldView } from './group-hold.handler';
import { PlatformPackageCatalogue } from '@infrastructure/persistence/platform-package-catalogue';
import { basketLines } from './basket';
import { planMember, type PlannedMember } from './party-member';
import { spreadOverParts } from '@domain/booking/package';
import { MobileContractError } from './mobile-booking.error';
import {
  MobileGroupReadHandler,
  type MobileGroupView,
} from '@application/queries/mobile-group-read.handler';
import { MobileGroupConfirmRepository } from '@infrastructure/persistence/mobile-group-confirm.repository';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { PlatformProductCatalogue } from '@infrastructure/persistence/platform-product-catalogue';
import {
  branchUtcOffsetMin,
  branchInstant,
} from '@infrastructure/persistence/hold.repository';
import { DAY_END_MIN, DAY_START_MIN } from '@domain/availability/grid';
import { toBranchMoment } from '@domain/booking/mobile-contract';
import {
  checkProducts,
  type PricedProduct,
} from '@domain/booking/mobile-products';
import {
  groupMoney,
  servicesVatFils,
  type AgeGroup,
} from '@domain/booking/group-money';
import {
  checkGroupMoney,
  checkParty,
} from '@domain/booking/mobile-group-contract';
import { oneCurrency, sourceOf } from '@domain/booking/service-resolution';

export interface MobileGroupMemberCommand {
  readonly ref: number;
  readonly kind: string;
  readonly id: string | null;
  readonly name: string | null;
  readonly ageGroup: string;
  readonly services: readonly {
    readonly id: string;
    readonly amount: number;
  }[];
  readonly products: readonly {
    readonly id: string;
    readonly amount: number;
    readonly quantity?: number;
  }[];
  readonly stylistId: string | null;
}

export interface MobileGroupBookingCommand {
  readonly salonId: string;
  readonly startTime: string;
  readonly members: readonly MobileGroupMemberCommand[];
  readonly amountWithoutTax: number;
  readonly taxAmount: number;
  readonly discount: number;
  readonly promoCode: string | null;
  readonly total: number;
  readonly depositPercent: number | null;
  readonly advancePaidAmount: number;
  readonly dueAmount: number;
  readonly paymentStatus: string;
  readonly status: string;
  readonly bookingType: string;
  /** From the verified token. Never from the payload. */
  readonly customerId: string;
  /**
   * The deposit percent this server holds (MOBILE_GROUP_DEPOSIT_PERCENT,
   * decision D1). Read by the controller, so the rule stays testable.
   */
  readonly heldDepositPercent: number;
}

/**
 * POST /v1/mobile-booking/group: the whole party as one booking, paid at the
 * salon (PAY_AFTER_CHECK_IN). Taking payment in the app is another team's
 * work, so there is no draft window and nothing here can lapse unpaid.
 *
 * ORCHESTRATION, the way the single mobile create is. In order:
 *
 *   1. the request on its own (mobile-group-contract.checkParty)
 *   2. every member's services, from the same catalogue a single uses
 *   3. every member's products, checked in ONE call so two members buying
 *      the last jar of something are both counted against its stock
 *   4. the money (group-money), and the app's figures against it
 *   5. the hold: GroupHoldHandler, the desk's own, called and not changed
 *   6. the confirm: MobileGroupConfirmRepository, one transaction
 *   7. the answer, read back from what was stored
 *
 * Everything that can refuse runs BEFORE the hold, so a refusal costs
 * nobody a chair. Anything that fails after the hold gives it back at once
 * rather than leaving the party's stylists dark for fifteen minutes.
 */
@Injectable()
export class MobileGroupBookingHandler {
  private static readonly log = new Logger(MobileGroupBookingHandler.name);

  constructor(
    private readonly holds: GroupHoldHandler,
    private readonly confirms: MobileGroupConfirmRepository,
    private readonly reads: MobileGroupReadHandler,
    private readonly lifecycle: LifecycleRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly productCatalogue: PlatformProductCatalogue,
    private readonly packageCatalogue: PlatformPackageCatalogue,
  ) {}

  async execute(cmd: MobileGroupBookingCommand): Promise<MobileGroupView> {
    // ---- 1. The party on its own ----------------------------------------
    const refusal = checkParty(
      {
        members: cmd.members.map((m) => ({
          ref: m.ref,
          kind: m.kind,
          id: m.id,
          name: m.name,
          ageGroup: m.ageGroup,
          serviceIds: m.services.map((s) => s.id),
          stylistId: m.stylistId,
        })),
        status: cmd.status,
        paymentStatus: cmd.paymentStatus,
        bookingType: cmd.bookingType,
      },
      cmd.customerId,
    );
    if (refusal !== null) {
      throw MobileContractError.of(
        refusal.field,
        refusal.code,
        refusal.message,
      );
    }

    const start = toBranchMoment(cmd.startTime, branchUtcOffsetMin());
    if (start === null) {
      throw MobileContractError.of(
        'start_time',
        'invalid_window',
        'start_time must be an ISO 8601 instant with an offset.',
      );
    }

    if (
      branchInstant(start.tradingDay, start.minuteOfDay).getTime() <= Date.now()
    ) {
      throw MobileContractError.of(
        'start_time',
        'invalid_window',
        'That time has already passed. Pick another time.',
      );
    }

    // ---- 2. Services, a member's packages expanded -------------------------
    const planned = await Promise.all(
      cmd.members.map((m, i) => this.memberOf(cmd.salonId, m, i)),
    );
    const services = planned.map((p) => p.basket.services);
    // Each member's lines as asked for: a hand-picked service, or a whole
    // package at its price. The money is worked out on these, as the app
    // works it out, and spread back over the parts when the lane is stored.
    const lines = cmd.members.map((m, i) =>
      basketLines(
        m.services.map((s) => s.id),
        planned[i]!.basket,
      ),
    );
    const basket = oneCurrency(services.flat());
    if (basket.kind === 'mixed') {
      throw MobileContractError.of(
        'members',
        'currency_mismatch',
        `These services are priced in ${basket.currencies.join(' and ')}; one party pays in one currency.`,
      );
    }

    const durations = planned.map((p) => p.durationMin);
    const longest = Math.max(...durations);
    if (
      start.minuteOfDay < DAY_START_MIN ||
      start.minuteOfDay + longest > DAY_END_MIN
    ) {
      throw MobileContractError.of(
        'start_time',
        'invalid_window',
        'The party would not finish within the hours this salon takes online bookings.',
      );
    }

    // ---- 3. Products -------------------------------------------------------
    const products = await this.productsOf(cmd, basket.currency);

    // ---- 4. Money ----------------------------------------------------------
    const money = groupMoney(
      cmd.members.map((m, i) => ({
        ageGroup: m.ageGroup as AgeGroup,
        // A package is ONE line at its price, so the child rule halves the
        // package once, as the app does, not each part with its own rounding.
        serviceFils: lines[i]!.map((l) => l.fils),
        products: products[i]!,
      })),
      cmd.heldDepositPercent,
    );
    const moneyRefusal = checkGroupMoney(
      {
        amountWithoutTax: cmd.amountWithoutTax,
        taxAmount: cmd.taxAmount,
        discount: cmd.discount,
        total: cmd.total,
        advancePaidAmount: cmd.advancePaidAmount,
        dueAmount: cmd.dueAmount,
        depositPercent: cmd.depositPercent,
      },
      money,
    );
    if (moneyRefusal !== null) {
      throw MobileContractError.of(
        moneyRefusal.field,
        moneyRefusal.code,
        moneyRefusal.message,
        moneyRefusal.expected,
      );
    }

    // ---- 5. Hold -------------------------------------------------------------
    let held: GroupHoldView;
    try {
      held = await this.holds.execute({
        branchId: cmd.salonId,
        organiserId: cmd.customerId,
        tradingDay: start.tradingDay,
        targetMin: start.minuteOfDay,
        mode: 'arrive_together',
        // The booker pays for everyone: a guest has no account to pay with.
        arrangement: 'organiser_pays_all',
        participants: cmd.members.map((m, i) => ({
          // Shown in the planner's refusals ("Nobody available covers
          // Liam's services"), so it is the member's own name.
          label: (m.name ?? '').trim() || `Member ${i + 1}`,
          serviceIds: m.services.map((s) => s.id),
          customerId: m.kind === 'guest' ? null : m.id,
          guestName: m.kind === 'guest' ? m.name : null,
          preferredStaffId: m.stylistId,
        })),
      });
    } catch (e) {
      throw translateHold(e);
    }

    // ---- 6. Confirm, giving the hold back if it does not happen ----------
    let booked;
    try {
      booked = await this.confirms.confirm({
        groupId: held.groupId,
        holdId: held.holdId,
        branchId: cmd.salonId,
        tradingDay: start.tradingDay,
        organiserId: cmd.customerId,
        depositPercent: money.depositPercent,
        promoCode: cmd.promoCode,
        // Lanes come back in the order the party was sent (planParty keeps
        // it), so lane i is member i, and so is participant position i.
        lanes: cmd.members.map((m, i) => {
          const lane = held.lanes[i];
          if (lane === undefined) {
            throw new Error(`the hold returned no lane for member ${i}`);
          }
          const member = planned[i]!;
          const list = member.basket.services;
          const share = money.members[i]!;
          // Each line as charged, spread back over the parts that make it
          // up: they add up to the line exactly (package.ts).
          const partFils = lines[i]!.flatMap((l, j) =>
            spreadOverParts(
              share.serviceFils[j]!,
              member.basket.pricesFils.slice(l.from, l.to),
            ),
          );
          return {
            position: i,
            clientRef: m.ref,
            ageGroup: m.ageGroup as AgeGroup,
            customerId: m.kind === 'guest' ? null : m.id,
            staffId: lane.staffId,
            startMin: start.minuteOfDay,
            endMin: start.minuteOfDay + durations[i]!,
            // The same chair the hold reserved: the last service's.
            resourceType: member.resourceType,
            items: list.map((s, k) => {
              const origin = member.basket.origins[k] ?? null;
              return {
                serviceId: s.id,
                serviceName: s.name,
                resourceType: s.resourceType,
                requiredSkill: s.skill,
                priceFils: partFils[k]!,
                durationMin: s.durationMin,
                source: sourceOf(s),
                package:
                  origin === null
                    ? null
                    : { id: origin.packageId, name: origin.name },
              };
            }),
            products: products[i]!,
            servicesNetFils: share.servicesNetFils,
            servicesVatFils: servicesVatFils(share, products[i]!),
            depositFils: share.depositFils,
            totalFils: share.totalFils,
          };
        }),
      });
    } catch (e) {
      await this.holds.release(held.holdId).catch(() => undefined);
      MobileGroupBookingHandler.log.warn(
        `mobile group confirm failed after hold ${held.holdId}; hold released`,
      );
      throw e;
    }

    if (booked.kind === 'hold_expired') {
      await this.holds.release(held.holdId).catch(() => undefined);
      throw MobileContractError.slotTaken(
        'That time no longer fits the whole party. Nothing was booked. Pick another time.',
      );
    }

    // ---- 7. The answer -------------------------------------------------------
    const names = new Map(
      cmd.members.flatMap((m, i) =>
        (m.name ?? '').trim() === '' ? [] : [[i, m.name!.trim()] as const],
      ),
    );
    try {
      return await this.reads.afterCreate(booked.groupId, names);
    } catch (e) {
      // Booked, but the answer could not be built. Saying "failed" while the
      // party holds the time would send the app into a retry that books a
      // second one, so the lanes are expired now: the same word the sweeper
      // writes for an unpaid draft, and it gives the chairs back.
      for (const lane of booked.lanes) {
        await this.lifecycle
          .transition({
            bookingId: lane.bookingId,
            to: 'expired',
            actor: 'system',
            actorId: null,
            reason: 'Creation failed after the party was written.',
          })
          .catch(() => null);
      }
      MobileGroupBookingHandler.log.warn(
        `mobile group ${booked.groupId} written but unreadable; lanes expired`,
      );
      throw e;
    }
  }

  /** One member's services, in the order picked, or `unknown_service`. */
  /**
   * One member's basket, packages expanded, through the step every party
   * path runs (party-member.ts) -- the hold runs it again on the same ids,
   * and gets the same answer.
   */
  private async memberOf(
    salonId: string,
    member: MobileGroupMemberCommand,
    index: number,
  ): Promise<PlannedMember> {
    const planned = await planMember(
      this.context,
      this.packageCatalogue,
      salonId,
      member.services.map((s) => s.id),
    );
    if (planned.basket.missing.length > 0) {
      throw MobileContractError.of(
        `members[${index}].services`,
        'unknown_service',
        `Not sold at this salon: ${planned.basket.missing.join(', ')}.`,
      );
    }
    return planned;
  }

  /**
   * Every member's products, priced from platform, or a refusal naming the
   * member and the line.
   *
   * Behind PRODUCTS_FROM_PLATFORM, exactly as the single create: with it off
   * a party with products is refused, never booked without them.
   */
  private async productsOf(
    cmd: MobileGroupBookingCommand,
    currency: string,
  ): Promise<PricedProduct[][]> {
    const flat = cmd.members.flatMap((m, member) =>
      m.products.map((line, index) => ({ member, index, line })),
    );
    const out: PricedProduct[][] = cmd.members.map(() => []);
    if (flat.length === 0) return out;

    if (!this.productCatalogue.enabled()) {
      throw MobileContractError.of(
        `members[${flat[0]!.member}].products`,
        'products_not_supported',
        'Products cannot be sold with a booking yet: there is no product ' +
          'catalogue to price against, so the line could not be verified.',
      );
    }

    const offers = await this.productCatalogue.resolve(
      cmd.salonId,
      flat.map((f) => f.line.id),
    );
    const checked = checkProducts({
      lines: flat.map((f) => f.line),
      offers,
      currency,
    });
    if (checked.kind === 'refused') {
      throw new MobileContractError(
        checked.errors.map((e) => ({
          ...e,
          field: e.field.replace(/^products\[(\d+)\]/, (_, k: string) => {
            const at = flat[Number(k)]!;
            return `members[${at.member}].products[${at.index}]`;
          }),
        })),
      );
    }
    checked.lines.forEach((line, k) => out[flat[k]!.member]!.push(line));
    return out;
  }
}

/**
 * The hold's refusals, in the app's words.
 *
 * A 409 from the hold is the party not fitting at that time, a race rather
 * than a mistake: `slot_taken`, and the planner's own sentence ("Only 2
 * professionals can cover this party...") is worth showing as it is.
 */
function translateHold(e: unknown): unknown {
  if (e instanceof ConflictException) {
    return MobileContractError.slotTaken(e.message);
  }
  if (e instanceof UnprocessableEntityException) {
    return MobileContractError.of('members', 'unknown_service', e.message);
  }
  return e;
}
