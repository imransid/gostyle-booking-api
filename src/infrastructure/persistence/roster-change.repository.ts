import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import { toUuid } from './hold.repository';
import { SlugIndex } from './slug-uuid';
import { STAFF_SLUGS } from '../fixtures/fixture-booking-context';
import type {
  ItemState,
  RosterChangeKind,
  WorklistItem,
} from '@domain/booking/roster-change';

export interface OpenChangeInput {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly kind: RosterChangeKind;
  readonly staffId: string | null;
  readonly resourceType: string | null;
  readonly reason: string;
}

export interface AffectedBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly staffId: string;
  readonly priceFils: number;
  readonly capturedFils: number;
  readonly resourceType: string;
  readonly claimPreMin: number;
  readonly claimPostMin: number;
  readonly customerId: string;
}

/** A move is only legal from a booking that has not happened yet. */
const DISTURBABLE = [
  'confirmed',
  'pending_payment',
  'pending_confirmation',
] as const;

@Injectable()
export class RosterChangeRepository {
  private static readonly log = new Logger(RosterChangeRepository.name);

  /** Columns hold uuids; the engine names professionals by slug. */
  private readonly staff = new SlugIndex(STAFF_SLUGS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  async open(input: OpenChangeInput): Promise<string> {
    const change = await this.prisma.rosterChange.create({
      data: {
        tenantId: this.tenants.current(),
        branchId: toUuid(input.branchId),
        tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
        kind: input.kind,
        staffId: input.staffId === null ? null : toUuid(input.staffId),
        resourceType: input.resourceType,
        reason: input.reason,
      },
      select: { id: true },
    });
    return change.id;
  }

  /**
   * Every booking this change disturbs.
   *
   * Blocking states only. A cancelled booking occupies nobody, and putting it
   * on the worklist would block the roster edit on a visit that is not
   * happening.
   */
  async affected(input: OpenChangeInput): Promise<AffectedBooking[]> {
    const day = new Date(`${input.tradingDay}T00:00:00Z`);
    const branch = toUuid(input.branchId);

    const items = await this.prisma.bookingItem.findMany({
      where: {
        ...(input.staffId === null ? {} : { staffId: toUuid(input.staffId) }),
        ...(input.resourceType === null
          ? {}
          : { resourceType: input.resourceType }),
        booking: {
          branchId: branch,
          tradingDay: day,
          status: { in: [...DISTURBABLE] },
        },
      },
      select: {
        staffId: true,
        resourceType: true,
        durationMin: true,
        priceFils: true,
        booking: {
          select: {
            id: true,
            code: true,
            startMinute: true,
            durationMin: true,
            priceFils: true,
            customerId: true,
          },
        },
      },
    });

    // What has actually been taken from the customer, per booking. The refund
    // on a salon cancellation is the captured figure, not the price.
    const ids = items.map((i) => i.booking.id);
    const ledger =
      ids.length === 0
        ? []
        : await this.prisma.depositLedger.groupBy({
            by: ['bookingId'],
            where: { bookingId: { in: ids } },
            _sum: { amountFils: true },
          });
    const capturedOf = new Map(
      ledger.map((l) => [l.bookingId, l._sum.amountFils ?? 0]),
    );

    const reservations =
      ids.length === 0
        ? []
        : await this.prisma.staffReservation.findMany({
            where: { bookingItem: { bookingId: { in: ids } }, blocking: true },
            select: {
              claimPreMin: true,
              claimPostMin: true,
              bookingItem: { select: { bookingId: true } },
            },
          });
    const claimsOf = new Map(
      reservations.map((r) => [
        r.bookingItem?.bookingId ?? '',
        { pre: r.claimPreMin, post: r.claimPostMin },
      ]),
    );

    return items.map((i) => ({
      bookingId: i.booking.id,
      code: i.booking.code,
      startMin: i.booking.startMinute,
      durationMin: i.booking.durationMin,
      // Back to the slug the engine speaks, per the boundary rule.
      staffId: this.staff.toSlug(i.staffId ?? ''),
      priceFils: i.booking.priceFils,
      capturedFils: Math.max(0, capturedOf.get(i.booking.id) ?? 0),
      resourceType: i.resourceType,
      claimPreMin: claimsOf.get(i.booking.id)?.pre ?? 0,
      claimPostMin: claimsOf.get(i.booking.id)?.post ?? 0,
      customerId: i.booking.customerId,
    }));
  }

  async addItems(
    changeId: string,
    bookings: readonly AffectedBooking[],
  ): Promise<void> {
    if (bookings.length === 0) return;
    await this.prisma.rosterChangeItem.createMany({
      data: bookings.map((b) => ({
        changeId,
        bookingId: b.bookingId,
        bookingCode: b.code,
        state: 'open' as const,
      })),
      skipDuplicates: true,
    });
  }

  /** Rungs 1 to 3 settled it without anybody being asked. */
  async markAutoRepaired(
    changeId: string,
    bookingId: string,
    rung: string,
  ): Promise<void> {
    await this.prisma.rosterChangeItem.updateMany({
      where: { changeId, bookingId },
      data: {
        state: 'auto_repaired',
        rung,
        resolvedAt: new Date(),
        proposal: Prisma.DbNull,
      },
    });
  }

  /**
   * Rung 4. The cancellation is PREPARED and the item stays open.
   *
   * Nothing is cancelled, refunded or credited here. A roster edit must not
   * cancel a paying customer while nobody is looking, and the gate only means
   * something if something is left for a person to clear.
   */
  async proposeCancellation(
    changeId: string,
    bookingId: string,
    proposal: {
      refundFils: number;
      goodwillFils: number;
      waitlistWindow: { fromMin: number; toMin: number };
      explanation: string;
    },
  ): Promise<void> {
    await this.prisma.rosterChangeItem.updateMany({
      where: { changeId, bookingId },
      data: { state: 'open', rung: 'salon_cancellation', proposal },
    });
  }

  /** The open item and the proposal it is waiting on. */
  async openItem(itemId: string): Promise<{
    id: string;
    changeId: string;
    bookingId: string;
    bookingCode: string;
    proposal: {
      refundFils: number;
      goodwillFils: number;
      waitlistWindow: { fromMin: number; toMin: number };
    } | null;
  } | null> {
    const row = await this.prisma.rosterChangeItem.findFirst({
      where: { id: itemId, state: 'open' },
      select: {
        id: true,
        changeId: true,
        bookingId: true,
        bookingCode: true,
        proposal: true,
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      changeId: row.changeId,
      bookingId: row.bookingId,
      bookingCode: row.bookingCode,
      proposal:
        row.proposal === null
          ? null
          : (row.proposal as unknown as {
              refundFils: number;
              goodwillFils: number;
              waitlistWindow: { fromMin: number; toMin: number };
            }),
    };
  }

  /** What the cancelled booking was, so it can be put back on the waitlist. */
  async bookingFacts(bookingId: string): Promise<{
    customerId: string;
    serviceId: string;
    tradingDay: string;
    branchId: string;
  } | null> {
    const b = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        customerId: true,
        branchId: true,
        tradingDay: true,
        items: {
          select: { serviceId: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
    });
    if (b === null) return null;
    return {
      customerId: b.customerId,
      branchId: b.branchId,
      serviceId: b.items[0]?.serviceId ?? '',
      tradingDay: b.tradingDay.toISOString().slice(0, 10),
    };
  }

  /** The goodwill credit that comes with a salon cancellation. */
  async postGoodwill(bookingId: string, amountFils: number): Promise<void> {
    if (amountFils <= 0) return;
    await this.prisma.depositLedger.create({
      data: {
        bookingId,
        // Positive: goodwill is money given, not taken. The ledger's own
        // CHECK enforces the sign for this entry type.
        entryType: 'goodwill',
        amountFils: Math.abs(amountFils),
        rail: 'wallet',
        actorKind: 'system',
      },
    });
  }

  async resolveItem(
    itemId: string,
    state: ItemState,
    rung: string | null,
  ): Promise<boolean> {
    const done = await this.prisma.rosterChangeItem.updateMany({
      where: { id: itemId, state: 'open' },
      data: {
        state,
        resolvedAt: new Date(),
        proposal: Prisma.DbNull,
        ...(rung === null ? {} : { rung }),
      },
    });
    return done.count > 0;
  }

  async worklist(changeId: string): Promise<WorklistItem[]> {
    const rows = await this.prisma.rosterChangeItem.findMany({
      where: { changeId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, bookingCode: true, state: true },
    });
    return rows.map((r) => ({
      id: r.id,
      bookingCode: r.bookingCode,
      state: r.state,
    }));
  }

  async detail(changeId: string): Promise<{
    id: string;
    branchId: string;
    tradingDay: string;
    kind: RosterChangeKind;
    staffId: string | null;
    resourceType: string | null;
    reason: string;
    committedAt: Date | null;
    items: {
      id: string;
      bookingCode: string;
      state: ItemState;
      rung: string | null;
      proposal: unknown;
    }[];
  } | null> {
    const c = await this.prisma.rosterChange.findUnique({
      where: { id: changeId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (c === null) return null;
    return {
      id: c.id,
      branchId: c.branchId,
      tradingDay: c.tradingDay.toISOString().slice(0, 10),
      kind: c.kind,
      staffId: c.staffId === null ? null : this.staff.toSlug(c.staffId),
      resourceType: c.resourceType,
      reason: c.reason,
      committedAt: c.committedAt,
      items: c.items.map((i) => ({
        id: i.id,
        bookingCode: i.bookingCode,
        state: i.state,
        rung: i.rung,
        proposal: i.proposal,
      })),
    };
  }

  /**
   * Record the commit.
   *
   * The gate is a TRIGGER, not a check in this method. A guard here would be
   * a guard one caller could forget; the trigger cannot be forgotten by
   * anybody, including a future version of this file.
   */
  async commit(
    changeId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.rosterChange.update({
          where: { id: changeId },
          data: { committedAt: new Date() },
        });
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'roster_change',
            aggregateId: changeId,
            eventType: 'roster_change.committed',
            payload: { changeId },
          },
        });
      });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The trigger refused. That is the gate doing its job, not a fault.
      if (
        message.includes('cannot commit') ||
        message.includes('already committed')
      ) {
        RosterChangeRepository.log.warn(
          `Commit refused for ${changeId}: ${message}`,
        );
        return { ok: false, message: triggerMessage(message) };
      }
      throw e;
    }
  }
}

/**
 * The trigger's own sentence, without Prisma's wrapper around it.
 *
 * The raw text arrives as "Database error. Code: `23514`. Message: `Roster
 * change ... cannot commit: 2 booking(s) still unresolved`", and the half
 * worth showing a person is the half the trigger wrote.
 */
function triggerMessage(message: string): string {
  const quoted = /`(Roster change [^`]+)`/.exec(message);
  if (quoted?.[1] !== undefined) return quoted[1];
  return (
    message.split('\n').find((l) => l.includes('Roster change')) ?? message
  );
}
