import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import { branchInstant, toUuid } from './hold.repository';
import type { AgeGroup } from '@domain/booking/group-money';
import { deriveGroupStatus } from '@domain/booking/group-status';
import type { PricedProduct } from '@domain/booking/mobile-products';
import type { ItemSource } from '@domain/booking/service-resolution';

/**
 * Turns a held mobile party into one booking per member, paid at the salon.
 *
 * NOT GroupConfirmRepository, and it does not call or change it. That one
 * is the desk's: it writes each member with one line and no money breakdown.
 * This one writes each member EXACTLY as a single mobile PAY_AFTER_CHECK_IN
 * booking is written (BookingRepository.confirm with no payment):
 *
 *   booking         confirmed, none_required, no link window, channel online,
 *                   net / tax / discount / deposit, and group_id
 *   booking_item    one per service, in the order picked, child price applied
 *   booking_product one per product line, the variant id NOT folded
 *   reservations    the hold's own rows, re-pointed at the first item
 *   history         held -> pending_payment
 *   outbox          booking.confirmed, the event a single DRAFT writes
 *
 * So the desk sees nothing new: a party lane (group: {id}) that is also a
 * mobile booking to be paid on arrival. Both shapes are already on its
 * screens. NO DRAFT WINDOW, so the payment link sweeper never touches these
 * (it takes only pending_payment rows with a window): a party is never
 * cancelled for want of an online payment. Taking payment in the app is
 * another team's work; the deposit is still stored on each row, as a single
 * PAY_AFTER_CHECK_IN booking stores it, so the desk can ask for it.
 *
 * NO RE-PLAN, on purpose. The desk confirm re-plans because its hold may be
 * ten minutes old. Here the hold was placed a moment ago in the same request,
 * and its reservations already block the time: the exclusion constraint on
 * staff_reservation is what guarantees nobody else has it. What this does
 * instead is re-point each member's OWN reservation, found by id, and refuse
 * if one is missing. (The desk confirm re-points chairs by start minute only,
 * which hands every chair of an arrive-together party to its first member.
 * That is on the follow-up list in gostyle-customer-api,
 * docs/GROUP_BOOKING_FOLLOW_UPS.md, and left alone here.)
 *
 * ONE TRANSACTION. Every member or none: a failure anywhere rolls the whole
 * party back, and the caller releases the hold.
 */

export interface MobileGroupLaneInput {
  /** The member's place in the party; the participant row's `position`. */
  readonly position: number;
  readonly clientRef: number;
  readonly ageGroup: AgeGroup;
  /** Whose account this is, or null for a guest. */
  readonly customerId: string | null;
  /** The stylist the hold gave this member, as the roster spells them. */
  readonly staffId: string;
  readonly startMin: number;
  readonly endMin: number;
  /** The chair the member's LAST service needs, as the hold reserved it. */
  readonly resourceType: string;
  readonly items: readonly {
    readonly serviceId: string;
    readonly serviceName: string;
    readonly resourceType: string;
    readonly requiredSkill: string;
    /** As charged: the child price already applied. */
    readonly priceFils: number;
    readonly durationMin: number;
    readonly source: ItemSource | null;
  }[];
  readonly products: readonly PricedProduct[];
  /** The services alone, as a single booking's row stores them. */
  readonly servicesNetFils: number;
  readonly servicesVatFils: number;
  readonly depositFils: number;
  /** Services and products, VAT included: the member's share. */
  readonly totalFils: number;
}

export interface MobileGroupConfirmInput {
  readonly groupId: string;
  readonly holdId: string;
  readonly branchId: string;
  readonly tradingDay: string;
  readonly organiserId: string;
  readonly depositPercent: number;
  /** Echoed on the booker's own lane, never applied (decision D2). */
  readonly promoCode: string | null;
  readonly lanes: readonly MobileGroupLaneInput[];
}

export type MobileGroupConfirmOutcome =
  | { readonly kind: 'hold_expired' }
  | {
      readonly kind: 'confirmed';
      readonly groupId: string;
      readonly lanes: readonly {
        readonly position: number;
        readonly participantId: string;
        readonly bookingId: string;
        readonly code: string;
      }[];
    };

/** A member's own reservation was not in the hold. Rolls the party back. */
class LaneLostError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'LaneLostError';
  }
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class MobileGroupConfirmRepository {
  private static readonly log = new Logger(MobileGroupConfirmRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  async confirm(
    input: MobileGroupConfirmInput,
  ): Promise<MobileGroupConfirmOutcome> {
    try {
      return await this.prisma.$transaction((tx) => this.write(tx, input), {
        timeout: 15_000,
        maxWait: 10_000,
      });
    } catch (e) {
      if (e instanceof LaneLostError) {
        MobileGroupConfirmRepository.log.warn(
          `Group ${input.groupId}: ${e.message}; nothing was written.`,
        );
        return { kind: 'hold_expired' };
      }
      throw e;
    }
  }

  private async write(
    tx: Tx,
    input: MobileGroupConfirmInput,
  ): Promise<MobileGroupConfirmOutcome> {
    const day = new Date(`${input.tradingDay}T00:00:00Z`);
    const branch = toUuid(input.branchId);

    // 1. The hold is alive, and locked so no sweeper takes it mid-write.
    const alive = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM hold
       WHERE id = ${input.holdId}::uuid
         AND expires_at > now()
       FOR UPDATE`;
    if (alive.length === 0) return { kind: 'hold_expired' };

    // 2. The group this hold made, still a fresh draft that no one has
    //    confirmed: not by the desk, not by an earlier try of this request.
    const group = await tx.bookingGroup.findUnique({
      where: { id: input.groupId },
      select: { status: true, source: true },
    });
    if (group === null || group.status !== 'draft' || group.source !== null) {
      return { kind: 'hold_expired' };
    }

    const participants = await tx.groupParticipant.findMany({
      where: { groupId: input.groupId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, customerId: true },
    });
    if (participants.length !== input.lanes.length) {
      return { kind: 'hold_expired' };
    }

    // 3. What the hold actually reserved. These rows ARE the time: each
    //    member's is re-pointed, never recreated, so the lane is never
    //    unprotected.
    const [staffRows, chairRows] = await Promise.all([
      tx.staffReservation.findMany({
        where: { holdId: input.holdId },
        select: { id: true, staffId: true, startMinute: true },
      }),
      tx.resourceReservation.findMany({
        where: { holdId: input.holdId },
        select: {
          id: true,
          resourceType: true,
          startMinute: true,
          durationMin: true,
        },
      }),
    ]);
    const chairsLeft = [...chairRows];

    const made: {
      position: number;
      participantId: string;
      bookingId: string;
      code: string;
    }[] = [];

    for (const lane of input.lanes) {
      const participant = participants.find(
        (p) => p.position === lane.position,
      );
      if (participant === undefined) {
        throw new LaneLostError(`no participant at position ${lane.position}`);
      }

      const staffId = toUuid(lane.staffId);
      const staffRow = staffRows.find(
        (r) => r.staffId === staffId && r.startMinute === lane.startMin,
      );
      if (staffRow === undefined) {
        throw new LaneLostError(
          `member ${lane.position}'s stylist reservation is not in the hold`,
        );
      }

      const duration = lane.endMin - lane.startMin;
      const chairAt = chairsLeft.findIndex(
        (r) =>
          r.resourceType === lane.resourceType &&
          r.startMinute === lane.startMin &&
          r.durationMin === duration,
      );
      if (chairAt === -1) {
        throw new LaneLostError(
          `member ${lane.position}'s chair reservation is not in the hold`,
        );
      }
      const chairRow = chairsLeft.splice(chairAt, 1)[0]!;

      const codeRows = await tx.$queryRaw<{ code: string }[]>`
        SELECT 'GS-' || nextval('booking_code_seq') AS code`;
      const code = codeRows[0]?.code;
      if (code === undefined)
        throw new Error('booking_code_seq returned nothing');

      const isBooker =
        participant.customerId !== null &&
        participant.customerId === toUuid(input.organiserId);

      const booking = await tx.booking.create({
        data: {
          tenantId: this.tenants.current(),
          code,
          branchId: branch,
          // A guest has no account; their lane is filed under the group, the
          // same as a desk party files one.
          customerId: participant.customerId ?? toUuid(input.groupId),
          groupId: input.groupId,
          status: 'confirmed',
          paymentStatus: 'none_required',
          tradingDay: day,
          startAt: branchInstant(input.tradingDay, lane.startMin),
          endAt: branchInstant(input.tradingDay, lane.endMin),
          startMinute: lane.startMin,
          durationMin: duration,
          priceFils: lane.servicesNetFils,
          depositFils: lane.depositFils,
          netFils: lane.servicesNetFils,
          taxFils: lane.servicesVatFils,
          discountFils: 0,
          promoCode: isBooker ? input.promoCode : null,
          requirementSource: `group deposit ${input.depositPercent}%`,
          // No window: nothing is paid online, so nothing can lapse.
          linkExpiresAt: null,
          channel: 'online',
        },
        select: { id: true, code: true },
      });

      let firstItemId: string | null = null;
      for (const [position, item] of lane.items.entries()) {
        const row = await tx.bookingItem.create({
          data: {
            bookingId: booking.id,
            serviceId: toUuid(item.serviceId),
            serviceName: item.serviceName,
            resourceType: item.resourceType,
            requiredSkill: item.requiredSkill,
            priceFils: item.priceFils,
            durationMin: item.durationMin,
            position,
            staffId,
            source: item.source,
          },
          select: { id: true },
        });
        firstItemId ??= row.id;
      }
      if (firstItemId === null) throw new Error('a booking needs an item');

      if (lane.products.length > 0) {
        await tx.bookingProduct.createMany({
          data: lane.products.map((p, position) => ({
            bookingId: booking.id,
            // The platform variant id as sold. NOT folded (CLAUDE.md 8).
            productId: p.productId,
            productName: p.productName,
            priceFils: p.priceFils,
            quantity: p.quantity,
            position,
          })),
        });
      }

      await tx.staffReservation.update({
        where: { id: staffRow.id },
        data: { holdId: null, bookingItemId: firstItemId },
      });
      await tx.resourceReservation.update({
        where: { id: chairRow.id },
        data: { holdId: null, bookingItemId: firstItemId },
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: 'held',
          toStatus: 'confirmed',
          reason: 'Mobile group booking',
          actorKind: 'customer',
          actorId: toUuid(input.organiserId),
        },
      });

      await tx.groupParticipant.update({
        where: { id: participant.id },
        data: {
          bookingId: booking.id,
          shareFils: lane.totalFils,
          ageGroup: lane.ageGroup,
          clientRef: lane.clientRef,
        },
      });

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'booking',
          aggregateId: booking.id,
          eventType: 'booking.confirmed',
          payload: {
            code: booking.code,
            holdId: input.holdId,
            startMinute: lane.startMin,
            endMinute: lane.endMin,
            depositFils: lane.depositFils,
            // Nothing was tendered: the same null a single booking paid on
            // arrival carries.
            rail: null,
            groupId: input.groupId,
          },
        },
      });

      made.push({
        position: lane.position,
        participantId: participant.id,
        bookingId: booking.id,
        code: booking.code,
      });
    }

    // 4. The group is now the app's one booking. Its status is DERIVED from
    //    the lanes by the shared rule (domain/booking/group-status.ts), here
    //    in the same transaction rather than a moment later by the status
    //    listener: every lane confirmed makes the party `confirmed`.
    await tx.bookingGroup.update({
      where: { id: input.groupId },
      data: {
        source: 'mobile',
        depositPercent: input.depositPercent,
        status: deriveGroupStatus(made.map(() => 'confirmed')).status,
        activeCount: made.length,
      },
    });

    // 5. Every reservation now hangs off a booking, so the hold is empty.
    await tx.hold.delete({ where: { id: input.holdId } });

    MobileGroupConfirmRepository.log.log(
      `Mobile group ${input.groupId} booked, pay at the salon: ${made
        .map((m) => m.code)
        .join(', ')}`,
    );

    return { kind: 'confirmed', groupId: input.groupId, lanes: made };
  }
}
