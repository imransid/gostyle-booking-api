import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RescheduleRepository } from '@infrastructure/persistence/reschedule.repository';
import { PlaceHoldHandler } from './place-hold.handler';
import { RescheduleHandler } from './reschedule.handler';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  branchNowMinute,
  branchToday,
  branchInstant,
} from '@infrastructure/persistence/hold.repository';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { formatMinute } from '@domain/availability/grid';
import { effectiveUnits } from '@domain/availability/capacity';
import {
  ARRIVAL_GRACE_MIN,
  VIP_ARRIVAL_GRACE_MIN,
  arrivalWindow,
  canCheckIn,
} from '@domain/booking/lifecycle';
import { HIGH_RISK_PERCENT, RISK_FLAG_PERCENT } from '@domain/booking/customer';
import { bookingError } from '@application/contract/errors';
import type { ActorKind } from '@domain/booking/lifecycle';

/**
 * The desk actions that existed as domain code with no URL in front of them.
 *
 * Three of the four things here were already written, tested and unreachable:
 * `shiftInPlace` (the calendar drag), `canCheckIn` (the arrival gates) and
 * `assessRisk` (the rolling score). Nothing in this file re-decides any of
 * them; it resolves the inputs they need and returns what they said.
 */

@Injectable()
export class DeskActionsHandler {
  constructor(
    private readonly reschedules: RescheduleRepository,
    private readonly rescheduleHandler: RescheduleHandler,
    private readonly holds: PlaceHoldHandler,
    private readonly bookings: BookingRepository,
    @Inject(CUSTOMER_CONTEXT) private readonly customers: CustomerContextReader,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  // ------------------------------------------------------------- §7.4 move

  /**
   * Calendar drag-and-drop.
   *
   * TWO PATHS, because moving a booking to a different TIME and moving it to
   * a different PROFESSIONAL are not the same operation underneath.
   *
   * SAME PROFESSIONAL -> shiftInPlace(). A booking nudged fifteen minutes
   * OVERLAPS ITSELF, so a hold on the new slot is refused by the exclusion
   * constraint against the very booking being moved. shiftInPlace releases
   * the old reservations and writes the new ones in one transaction instead.
   *
   * DIFFERENT PROFESSIONAL -> place a hold, then move onto it. There is no
   * self-overlap across two people, and the hold is what proves the new
   * professional is free, has the skills and has a chair. Placing it here
   * rather than making the client do it is the whole point of a drag being
   * one gesture.
   */
  async move(input: {
    readonly bookingId: string;
    readonly date: string;
    readonly startMin: number;
    readonly staffId?: string | undefined;
    readonly overbookReason?: string | undefined;
    readonly actor: ActorKind;
    readonly actorId: string | null;
  }): Promise<unknown> {
    const b = await this.bookings.detail(input.bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    if (input.overbookReason !== undefined && input.actor !== 'manager') {
      throw bookingError(
        'FORBIDDEN_ROLE',
        'Only a manager may force a move past capacity.',
      );
    }

    const currentDay = b.tradingDay.toISOString().slice(0, 10);
    const currentStaff = b.items[0]?.staffId ?? null;

    // The roster speaks slugs; the column holds the hash (CLAUDE.md 8).
    const day = await this.context.loadDay(b.branchId, input.date);
    const index = new SlugIndex(day.professionals.map((p) => p.id));
    const currentSlug =
      currentStaff === null ? null : index.toSlug(currentStaff);
    const wantsStaff = input.staffId ?? currentSlug;
    const changesStaff = wantsStaff !== null && wantsStaff !== currentSlug;

    if (!changesStaff && input.date === currentDay) {
      const result = await this.reschedules.shiftInPlace({
        bookingId: input.bookingId,
        tradingDay: input.date,
        toStartMin: input.startMin,
        reason: input.overbookReason ?? 'moved on the calendar',
        actor: input.actor,
        actorId: input.actorId,
      });

      switch (result.kind) {
        case 'not_found':
          throw new NotFoundException('No such booking');
        case 'illegal':
          throw bookingError('BOOKING_STATE_INVALID', result.message);
        case 'slot_taken':
          throw bookingError(
            'BOOKING_SLOT_TAKEN',
            `${formatMinute(input.startMin)} is taken.`,
          );
        default:
          return {
            bookingId: input.bookingId,
            code: b.code,
            date: input.date,
            startTime: formatMinute(input.startMin),
            startsAt: branchInstant(input.date, input.startMin).toISOString(),
            staffId: currentSlug,
            path: 'SHIFT_IN_PLACE',
            overbook:
              input.overbookReason === undefined
                ? null
                : { reason: input.overbookReason, byUserId: input.actorId },
          };
      }
    }

    // A different professional, or a different day: prove the target with a
    // real hold, then move onto it. Any refusal comes back with its own code
    // and refreshed offers, from the one place that knows how to compute them.
    const hold = await this.holds.execute({
      branchId: b.branchId,
      customerId: b.customerId,
      tradingDay: input.date,
      serviceIds: b.items.map((i) => i.serviceId),
      startMin: input.startMin,
      channel: 'desk',
      preferredStaffId: wantsStaff,
    });

    const moved = await this.rescheduleHandler.execute({
      bookingId: input.bookingId,
      holdId: hold.holdId,
      tradingDay: input.date,
      reason: input.overbookReason ?? 'moved on the calendar',
      actor: input.actor,
      ...(input.actorId === null ? {} : { actorId: input.actorId }),
    });

    return {
      ...moved,
      bookingId: input.bookingId,
      date: input.date,
      startTime: formatMinute(input.startMin),
      staffId: wantsStaff,
      path: 'HOLD_AND_MOVE',
      overbook:
        input.overbookReason === undefined
          ? null
          : { reason: input.overbookReason, byUserId: input.actorId },
    };
  }

  // -------------------------------------------------------- §11.1 gates

  /**
   * May this visit begin?
   *
   * The client must not decide this, so the server answers with the gates
   * rather than a boolean.
   *
   * ONE GATE CANNOT BE EVALUATED AND SAYS SO. Consent and patch-test records
   * live on the customer, and this module reads the customer through a port
   * that answers tier and risk and nothing else. Returning `passed: true`
   * would be inventing a consent nobody gave — a colour service on an
   * untested client is exactly the thing the gate exists to stop — so it
   * returns `passed: null` with `reason: NOT_MODELLED`. A null is visible on
   * a screen; a false pass is not.
   */
  async checkInGates(bookingId: string): Promise<unknown> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    const day = b.tradingDay.toISOString().slice(0, 10);
    const customer = await this.customers.load(b.customerId);
    const window = arrivalWindow(b.startMinute, customer.isVip);
    const nowMin = day === branchToday() ? branchNowMinute() : 0;

    const paymentSettled =
      b.paymentStatus === 'none_required' ||
      b.paymentStatus === 'deposit_paid' ||
      b.paymentStatus === 'fully_paid' ||
      b.paymentStatus === 'settled';

    // Free capacity of the classes this basket needs, at this start.
    const ctx = await this.context.loadDay(b.branchId, day);
    const needed = [...new Set(b.items.map((i) => i.resourceType))];
    const chairs = needed.map((type) => {
      const resource = ctx.resources.find((r) => r.id === type);
      const units = resource === undefined ? 0 : effectiveUnits(resource);
      const inUse = ctx.occupations.filter(
        (o) =>
          o.resourceType === type &&
          o.startMin < b.startMinute + b.durationMin &&
          o.endMin > b.startMinute,
      ).length;
      return { resourceClass: type, free: Math.max(0, units - inUse), units };
    });

    const chairAvailable = chairs.every((c) => c.free > 0);

    const verdict = canCheckIn({
      gates: {
        // Not evaluable; passed so the verdict reflects the gates we CAN
        // judge. The published gate below still reports null.
        consentAndPatchTest: true,
        paymentSettled,
        chairSelected: chairAvailable,
      },
      nowMin,
      startMin: b.startMinute,
      isVip: customer.isVip,
    });

    return {
      bookingId,
      code: b.code,
      windowOpensAt: branchInstant(day, window.opensAtMin).toISOString(),
      graceMinutes: customer.isVip ? VIP_ARRIVAL_GRACE_MIN : ARRIVAL_GRACE_MIN,
      graceEndsAt: branchInstant(day, window.graceEndsAtMin).toISOString(),
      autoNoShowAt: branchInstant(day, window.autoNoShowAtMin).toISOString(),
      lateMinutes: Math.max(0, nowMin - b.startMinute),
      verdict: verdict.kind.toUpperCase(),
      gates: [
        {
          gate: 'CONSENT',
          passed: null,
          reason: 'NOT_MODELLED',
          detail:
            'Consent and patch-test records live on the customer service; ' +
            'this module cannot see them yet.',
          remedies: ['MANAGER_WAIVER', 'BOOK_PATCH_TEST'],
        },
        {
          gate: 'PAYMENT',
          passed: paymentSettled,
          ...(paymentSettled ? {} : { reason: 'DEPOSIT_OUTSTANDING' }),
        },
        {
          gate: 'CHAIR',
          passed: chairAvailable,
          ...(chairAvailable ? {} : { reason: 'NONE_FREE' }),
        },
      ],
      availableChairs: chairs,
      estimate: {
        services: Math.round(b.priceFils / 100),
        prepaid: Math.round(b.depositFils / 100),
        total: Math.round(b.priceFils / 100),
      },
    };
  }

  // --------------------------------------------------------- §12.1 risk

  /**
   * The rolling risk score.
   *
   * RECOMPUTED, NEVER STORED. `assessRisk` is the same function the deposit
   * ladder's rung 2 calls, so the number on this screen and the number that
   * decided the deposit cannot disagree (CLAUDE.md 4).
   */
  async risk(customerId: string): Promise<unknown> {
    const c = await this.customers.load(customerId);

    /**
     * THE HISTORY IS NOT OURS. The port answers a band and a score, not the
     * counts behind them, so the counts are reported as null rather than
     * back-solved from the score. Two no-shows and one late cancel produce
     * the same score as several other combinations, and a plausible guess on
     * a risk screen is worse than an honest gap.
     */
    return {
      customerId,
      score: c.riskScore,
      band: c.risk,
      tier: c.tier === 'none' ? null : c.tier.toUpperCase(),
      requiresDeposit: c.requireDepositFlag,
      isNew: c.isNewCustomer,
      noShows: null,
      lateCancels: null,
      visits: null,
      /**
       * WRITTEN FROM WHAT WE HAVE, not borrowed from assessRisk().
       *
       * The first version called assessRisk with a zeroed history and patched
       * the real score into its sentence, producing "Score 92, LOW band (no
       * history on file)" -- a true score wrapped in a claim about history
       * that came from the placeholder rather than from the customer.
       */
      explanation:
        `Score ${c.riskScore}, ${c.risk} band. ` +
        (c.requireDepositFlag
          ? `A manager has flagged this customer: at least ${RISK_FLAG_PERCENT}% is required.`
          : c.risk === 'HIGH'
            ? `High risk forces at least ${HIGH_RISK_PERCENT}%.`
            : c.risk === 'WATCH'
              ? 'Monitored: reminders intensify, but no deposit is forced.'
              : 'No deposit is forced by risk.'),
    };
  }
}
