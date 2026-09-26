import type {
  BookingStatus,
  PaymentStatus,
} from '../../generated/prisma/enums';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import { isExclusionViolation, isUniqueViolationOn } from './pg-errors';
import { toUuid } from './hold.repository';
import { ItemSource } from '@domain/booking/service-resolution';
import {
  ARCHIVE_STATES,
  NEVER_LISTED_STATES,
} from '@domain/booking/booking-shelf';
import { BLOCKING_STATES } from '@domain/booking/lifecycle';
import { RELEASED_SESSION_REASON } from '@domain/booking/mobile-series-list';

export type PaymentRail =
  'wallet' | 'card' | 'apple_pay' | 'cash' | 'link' | 'internal';

/** What was already captured. null means the requirement was "none". */
export interface PaymentRecord {
  readonly amountFils: number;
  readonly rail: PaymentRail;
  readonly gatewayRef: string | null;
}

export interface ConfirmItem {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly resourceType: string;
  readonly requiredSkill: string;
  /** Frozen at booking time. The menu can change; this cannot. */
  readonly priceFils: number;
  readonly durationMin: number;
  readonly staffId: string;
  /**
   * Which catalogue priced this line. See BookingItem.source.
   *
   * Carried rather than re-derived: the handler already holds the resolved
   * service, and persistence asking a second time could get a different
   * answer than the one that produced this price.
   */
  readonly source: ItemSource;
}

/**
 * One product sold with the visit. Built and priced by the mobile handler;
 * persistence only writes it (CLAUDE.md 7).
 */
export interface ConfirmProduct {
  /** The VARIANT id, a lowercase uuid. Not folded through toUuid. */
  readonly productId: string;
  readonly productName: string;
  /** Unit price, whole fils, frozen from the catalogue. */
  readonly priceFils: number;
  readonly quantity: number;
}

export interface ConfirmBookingInput {
  readonly holdId: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly tradingDay: string;
  readonly channel: string;
  readonly items: readonly ConfirmItem[];
  /**
   * Products sold with the visit. Every desk path omits it and writes no
   * booking_product rows, exactly as before.
   */
  readonly products?: readonly ConfirmProduct[];

  readonly priceFils: number;
  readonly depositFils: number;
  /**
   * The §2 breakdown, from the verified quote. Optional so the desk paths
   * that have no such breakdown keep compiling and keep writing NULLs --
   * which is what they did before, and is honest for them.
   */
  readonly netFils?: number | null;
  readonly taxFils?: number | null;
  readonly discountFils?: number | null;
  readonly promoCode?: string | null;
  /** "Service rule 50% (Full color and gloss)". Answers "why was I charged this". */
  readonly requirementSource: string | null;
  readonly payment: PaymentRecord | null;
  readonly actorId: string | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string;
  /**
   * When the payment link closes. Null on every rail but 'link'.
   *
   * Computed by the handler, because refusing a link that is already dead is
   * a decision about what to tell the desk, not a decision about what to
   * store.
   */
  readonly linkExpiresAt: Date | null;
  /**
   * Exactly what a retry should receive. Stored verbatim, so a replay is
   * answered from bytes rather than re-derived from a world that has
   * already changed underneath it.
   */
  readonly responseView?: unknown;
}

export interface ConfirmedBooking {
  readonly bookingId: string;
  readonly code: string;
  /**
   * The enum, not a string. The contract layer shouts these into
   * SCREAMING_SNAKE for the wire and cannot do that safely from `string`:
   * `Uppercase<string>` is just `string` again, and the compiler would stop
   * checking that a real status came back.
   */
  readonly status: BookingStatus;
  readonly paymentStatus: PaymentStatus;
  readonly startMin: number;
  readonly durationMin: number;
  readonly staffId: string;
}

export type ConfirmOutcome =
  | { readonly kind: 'confirmed'; readonly booking: ConfirmedBooking }
  /** The same Idempotency-Key came back. Return the original, charge nothing. */
  | { readonly kind: 'replayed'; readonly booking: ConfirmedBooking }
  /** Money is never taken against a dead hold. */
  | { readonly kind: 'hold_expired' }
  /** Somebody else got the slot between the hold and the confirm. */
  | { readonly kind: 'slot_taken' }
  /**
   * This gateway reference is already on the ledger, under a DIFFERENT
   * request. Not a retry -- a retry carries the Idempotency-Key and is
   * replayed above -- so the honest answer is a refusal, not a second
   * booking against one payment.
   */
  | { readonly kind: 'payment_already_recorded' };

@Injectable()
export class BookingRepository {
  private static readonly log = new Logger(BookingRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * Turn a hold into a booking. Nine writes, one COMMIT.
   *
   * The rule the whole method serves: in EVERY failure branch, the answer to
   * "was anything charged?" is no. Postgres rolls back all nine or none, so
   * there is no half-confirmed state to clean up later.
   */
  async confirm(input: ConfirmBookingInput): Promise<ConfirmOutcome> {
    // Fast path. A retried request should not even open a transaction.
    if (input.idempotencyKey !== null) {
      const seen = await this.findReplay(input.idempotencyKey);
      if (seen !== null) return { kind: 'replayed', booking: seen };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Lock the hold and prove it is alive, in one statement.
        //    FOR UPDATE stops the sweeper deleting it, and stops a second
        //    confirm running beside us, for as long as we hold the row.
        const alive = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM hold
           WHERE id = ${input.holdId}::uuid
             AND expires_at > now()
           FOR UPDATE`;
        if (alive.length === 0) {
          throw new HoldExpiredError();
        }

        // The reservations ARE the truth about what was held. Reading the
        // times from them rather than from the request means a tampered or
        // stale client cannot book a different slot than the one it holds.
        const staffRes = await tx.staffReservation.findFirst({
          where: { holdId: input.holdId },
          orderBy: { startMinute: 'asc' },
        });
        if (staffRes === null) throw new HoldExpiredError();

        const totalDuration = input.items.reduce(
          (a, i) => a + i.durationMin,
          0,
        );
        const endMinute = staffRes.startMinute + totalDuration;

        const codeRows = await tx.$queryRaw<{ code: string }[]>`
          SELECT 'GS-' || nextval('booking_code_seq') AS code`;
        const code = codeRows[0]?.code;
        if (code === undefined) {
          throw new Error('booking_code_seq returned nothing');
        }

        const { status, paymentStatus } = resolveStatus(input);

        // 2. The visit.
        const booking = await tx.booking.create({
          data: {
            tenantId: this.tenants.current(),
            code,
            branchId: toUuid(input.branchId),
            customerId: toUuid(input.customerId),
            status,
            paymentStatus,
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            startAt: staffRes.startAt,
            endAt: staffRes.endAt,
            startMinute: staffRes.startMinute,
            durationMin: totalDuration,
            priceFils: input.priceFils,
            depositFils: input.depositFils,
            /**
             * THE BREAKDOWN, WRITTEN AT LAST.
             *
             * These four columns were added for the FE contract and then
             * never filled by anything, so every booking carried NULLs. That
             * only showed up when a booking could not be re-quoted -- a
             * retired service, or a read that arrives without a tenant --
             * and there was nothing on the row to fall back to, so a booking
             * that existed could be neither read nor paid for.
             *
             * `price_fils` alone cannot stand in: it is the NET total with
             * no VAT in it, and reporting it as the total understates every
             * booking by the tax.
             *
             * Taken from the VERIFIED quote, never from the client's claim.
             * §3 already compared the two and refused a mismatch, so by the
             * time this runs they agree -- and the server's figure is the
             * one that was actually charged.
             */
            netFils: input.netFils ?? null,
            taxFils: input.taxFils ?? null,
            discountFils: input.discountFils ?? null,
            promoCode: input.promoCode ?? null,
            requirementSource: input.requirementSource,
            linkExpiresAt: input.linkExpiresAt,
            channel: input.channel,
          },
          select: { id: true, code: true },
        });

        // 3. The line items, each with its frozen price.
        const items = [];
        for (const [position, item] of input.items.entries()) {
          items.push(
            await tx.bookingItem.create({
              data: {
                bookingId: booking.id,
                serviceId: toUuid(item.serviceId),
                serviceName: item.serviceName,
                resourceType: item.resourceType,
                requiredSkill: item.requiredSkill,
                priceFils: item.priceFils,
                durationMin: item.durationMin,
                position,
                staffId: toUuid(item.staffId),
                source: item.source,
              },
              select: { id: true },
            }),
          );
        }
        const firstItem = items[0];
        if (firstItem === undefined) throw new Error('a booking needs an item');

        // 3b. Products, in the SAME commit as the booking. They take no time
        //     and no reservation, so nothing below reads them. `position` is
        //     the order the customer picked them in, as for items.
        const products = input.products ?? [];
        if (products.length > 0) {
          await tx.bookingProduct.createMany({
            data: products.map((p, position) => ({
              bookingId: booking.id,
              productId: p.productId,
              productName: p.productName,
              priceFils: p.priceFils,
              quantity: p.quantity,
              position,
            })),
          });
        }

        // 4. THE IMPORTANT ONE. The reservations are RE-POINTED, not deleted

        // 4. THE IMPORTANT ONE. The reservations are RE-POINTED, not deleted
        //    and remade. The row never leaves the table, so the capacity is
        //    held continuously from hold to booking. There is no instant, in
        //    any isolation level, where the slot looks free.
        await tx.staffReservation.updateMany({
          where: { holdId: input.holdId },
          data: { holdId: null, bookingItemId: firstItem.id },
        });
        await tx.resourceReservation.updateMany({
          where: { holdId: input.holdId },
          data: { holdId: null, bookingItemId: firstItem.id },
        });

        // 5. Money. Append-only, signed, and only when something moved.
        //    A payment link captures nothing yet, so no entry: the ledger
        //    records money, not intentions.
        if (input.payment !== null && input.payment.rail !== 'link') {
          await tx.depositLedger.create({
            data: {
              bookingId: booking.id,
              entryType: 'captured',
              amountFils: input.payment.amountFils,
              rail: input.payment.rail,
              gatewayRef: input.payment.gatewayRef,
              actorKind: input.actorId === null ? 'system' : 'staff',
              actorId: input.actorId === null ? null : toUuid(input.actorId),
            },
          });
        }

        // 6. Audit.
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: booking.id,
            fromStatus: 'held',
            toStatus: status,
            reason: input.requirementSource,
            actorKind: input.actorId === null ? 'system' : 'staff',
            actorId: input.actorId === null ? null : toUuid(input.actorId),
          },
        });

        // 7. The event, in the SAME commit. Redis can be on fire and the
        //    reminder still cannot be lost: a relay picks this up later.
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: booking.id,
            eventType: 'booking.confirmed',
            payload: {
              code: booking.code,
              // Which hold became this booking. The walk-in queue uses it to
              // find its own entry and clear it, so the desk does not have to
              // tell us twice that somebody sat down.
              holdId: input.holdId,
              startMinute: staffRes.startMinute,
              endMinute,
              depositFils: input.depositFils,
              rail: input.payment?.rail ?? null,
            },
          },
        });

        const result: ConfirmedBooking = {
          bookingId: booking.id,
          code: booking.code,
          status,
          paymentStatus,
          startMin: staffRes.startMinute,
          durationMin: totalDuration,
          staffId: staffRes.staffId,
        };

        // 8. Retry safety, inside the transaction so it cannot disagree
        //    with whether the booking exists.
        if (input.idempotencyKey !== null) {
          await tx.idempotencyKey.create({
            data: {
              key: input.idempotencyKey,
              operation: 'POST /v1/bookings',
              requestHash: input.requestHash,
              responseStatus: 201,
              responseBody: input.responseView ?? { ...result },
              bookingId: booking.id,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }

        // 9. The hold is spent. Its reservations already belong to the
        //    booking, so nothing cascades away with it.
        await tx.hold.delete({ where: { id: input.holdId } });

        return { kind: 'confirmed', booking: result };
      });
    } catch (e) {
      if (e instanceof HoldExpiredError) return { kind: 'hold_expired' };
      if (isExclusionViolation(e)) return { kind: 'slot_taken' };

      // BEFORE the idempotency branch below, which reads any P2002 as "the
      // same key raced us". A reused gateway_ref is a different unique
      // index entirely: findReplay() finds nothing for it, and the rethrow
      // reached the desk as a 500 for what is an ordinary mistake.
      if (isUniqueViolationOn(e, 'gateway_ref')) {
        return { kind: 'payment_already_recorded' };
      }

      // A concurrent request with the same key won the race. Both are the
      // same intent, so return what it produced rather than charging twice.
      if (
        input.idempotencyKey !== null &&
        (e as { code?: unknown })?.code === 'P2002'
      ) {
        const seen = await this.findReplay(input.idempotencyKey);
        if (seen !== null) return { kind: 'replayed', booking: seen };
      }

      BookingRepository.log.error(
        `confirm() failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`,
      );
      throw e;
    }
  }

  private async findReplay(key: string): Promise<ConfirmedBooking | null> {
    const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (row === null || row.responseBody === null) return null;
    return row.responseBody as unknown as ConfirmedBooking;
  }

  /**
   * One booking, with everything the drawer renders.
   *
   * Reads only, and returns the row as Prisma shapes it. Translating into the
   * front end's vocabulary happens in the handler, because that is where
   * every other view is translated and a second translation site is how the
   * two drift (CLAUDE.md 4).
   */
  /**
   * The intervals these staff are already occupied for, in one window.
   *
   * WHY THIS EXISTS. gostyle-customer-api builds the customer's slot picker
   * from platform shifts and a `booking` table in the PLATFORM database --
   * which this service has never written to, because bookings live here in
   * `gostyle_booking`. So the picker computed free time against zero
   * bookings and offered slots that were already sold; the customer picked
   * one and the engine refused it, naming the stylist. It read as a stylist
   * problem, a clock problem and a timezone problem in turn before anyone
   * looked at which table was being queried.
   *
   * BLOCKING_STATES, imported not re-listed. It is the engine's own answer
   * to "does this still occupy a chair", and a second copy here would be the
   * one that goes stale the day a status is added (CLAUDE.md 4). Note it
   * includes `completed` and `settled`: the visit is over but it happened,
   * and pretending the time is free would let a booking land on top of it.
   *
   * OVERLAP, not containment: a booking that began before the window and
   * runs into it occupies the same minutes as one starting inside it.
   */
  async busyFor(input: {
    readonly branchId: string;
    readonly staffIds: readonly string[];
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly { staffId: string; startAt: Date; endAt: Date }[]> {
    if (input.staffIds.length === 0) return [];

    const rows = await this.prisma.bookingItem.findMany({
      where: {
        staffId: { in: input.staffIds.map((id) => toUuid(id)) },
        booking: {
          branchId: toUuid(input.branchId),
          status: { in: [...BLOCKING_STATES] },
          startAt: { lt: input.to },
          endAt: { gt: input.from },
        },
      },
      select: {
        staffId: true,
        booking: { select: { startAt: true, endAt: true } },
      },
    });

    return rows
      .filter((r): r is typeof r & { staffId: string } => r.staffId !== null)
      .map((r) => ({
        staffId: r.staffId,
        startAt: r.booking.startAt,
        endAt: r.booking.endAt,
      }));
  }

  async detail(bookingId: string) {
    return this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        items: { orderBy: { position: 'asc' } },
        products: { orderBy: { position: 'asc' } },
        ledger: { orderBy: { createdAt: 'asc' } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  /**
   * One shelf of one customer's bookings, and the size of all of them.
   *
   * THE SHELF IS DECIDED IN SQL, from `ARCHIVE_STATES` and `endAt`, which is
   * the same pair `shelfOf` reads. It cannot call `shelfOf` here -- that
   * would mean fetching every booking a customer has ever made in order to
   * throw most of them away -- so the domain exports the set and the spec
   * pins the two together for all fourteen statuses. Do not write status
   * names into this file (CLAUDE.md 4).
   *
   * `counts` comes back with the page because the app draws three tab
   * badges and would otherwise ask three times for numbers it renders at
   * once. They are counted over the SAME listable set as the page, so the
   * badge and the list it opens cannot disagree.
   *
   * `booking_customer_idx` is `[customer_id, start_at DESC]`, which is
   * exactly this query: the customer narrows it and the sort is served by
   * the index in both directions.
   */
  async customerPage(input: {
    readonly customerId: string;
    readonly shelf: 'upcoming' | 'archive';
    readonly now: Date;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{
    readonly rows: Awaited<ReturnType<BookingRepository['pageRows']>>;
    readonly count: number;
    readonly counts: { readonly upcoming: number; readonly archive: number };
  }> {
    const customerId = toUuid(input.customerId);
    const listable = {
      customerId,
      status: { notIn: [...NEVER_LISTED_STATES] },
      // Two exclusions. The first mirrors `isListable`: an ABANDONED
      // checkout -- unpaid and already run out -- is litter, not history. A
      // LIVE draft is listed, so an interrupted checkout can be found again.
      //
      // The second (step 5): a visit released when a routine could not be
      // booked in full. It was cancelled at once, never by the customer, and
      // never joined a routine, so it is not history either. It can only
      // match visits the routine create made, so every other list is as
      // before.
      NOT: [
        { paymentStatus: 'unpaid' as const, status: 'expired' as const },
        {
          status: 'cancelled' as const,
          seriesId: null,
          statusHistory: { some: { reason: RELEASED_SESSION_REASON } },
        },
      ],
    };

    const upcoming = {
      ...listable,
      status: { notIn: [...NEVER_LISTED_STATES, ...ARCHIVE_STATES] },
      endAt: { gt: input.now },
    };
    const archive = {
      ...listable,
      OR: [
        { status: { in: [...ARCHIVE_STATES] } },
        { endAt: { lte: input.now } },
      ],
    };
    const where = input.shelf === 'upcoming' ? upcoming : archive;

    // One round trip. The two counts are needed whichever shelf was asked
    // for, so they are not conditional on it.
    //
    // A pageSize of 0 asks for the BADGES ONLY, and skips the page query
    // rather than passing `take: 0` to Prisma -- a zero take is not a
    // documented "no rows" and is the sort of thing that quietly becomes
    // "all rows" across a version.
    const [rows, count, upcomingCount, archiveCount] = await Promise.all([
      input.pageSize > 0
        ? this.pageRows(where, input.shelf, input.page, input.pageSize)
        : Promise.resolve([]),
      this.prisma.booking.count({ where }),
      this.prisma.booking.count({ where: upcoming }),
      this.prisma.booking.count({ where: archive }),
    ]);

    return {
      rows,
      count,
      counts: { upcoming: upcomingCount, archive: archiveCount },
    };
  }

  /**
   * The page itself. `items` for the service and stylist lines, `ledger` for
   * what was actually captured -- both of which the row renders, and neither
   * of which is worth a second query per booking.
   *
   * `statusHistory` is NOT included: the drawer shows it, a list row does
   * not, and it is the one relation that grows without bound.
   */
  private pageRows(
    where: object,
    shelf: 'upcoming' | 'archive',
    page: number,
    pageSize: number,
  ) {
    return this.prisma.booking.findMany({
      where,
      include: {
        items: { orderBy: { position: 'asc' } },
        products: { orderBy: { position: 'asc' } },
        ledger: { orderBy: { createdAt: 'asc' } },
      },
      // Soonest first on the way forward, most recent first on the way back
      // (§2). `id` breaks a tie so a page boundary cannot show one booking
      // twice and skip another.
      orderBy: [
        { startAt: shelf === 'upcoming' ? 'asc' : 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }
}

/**
 * Table 8.8. The pair depends only on the requirement and the rail.
 *
 * Keeping booking status and payment status separate is what lets a Confirmed
 * booking be unpaid, deposit-paid, or fully prepaid without inventing new
 * lifecycle states for each.
 */
function resolveStatus(input: ConfirmBookingInput): {
  status: 'confirmed' | 'pending_payment';
  paymentStatus: 'none_required' | 'unpaid' | 'deposit_paid' | 'fully_paid';
} {
  if (input.payment === null) {
    return { status: 'confirmed', paymentStatus: 'none_required' };
  }
  if (input.payment.rail === 'link') {
    // The link is out. The slot stays reserved for the window, but nothing
    // has been captured, so the booking is not confirmed yet.
    return { status: 'pending_payment', paymentStatus: 'unpaid' };
  }
  return {
    status: 'confirmed',
    paymentStatus:
      input.payment.amountFils >= input.priceFils
        ? 'fully_paid'
        : 'deposit_paid',
  };
}

class HoldExpiredError extends Error {
  constructor() {
    super('hold expired');
  }
}
