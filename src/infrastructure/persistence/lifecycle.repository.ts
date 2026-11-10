import type { PaymentStatus } from '../../generated/prisma/enums';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import { arrivalClaimed } from './check-in-request.repository';
import type { CheckInVia } from '@domain/booking/check-in-attribution';
import { depositPosition } from '@domain/journal/deposit-position';
import {
  planPosSettlement,
  type SettlementRow,
} from '@domain/pos/pos-settlement';
import {
  checkTransition,
  releasesCapacity,
  cancellationOutcome,
  noShowOutcome,
  type ActorKind,
  type BookingStatus,
  type CancelInitiator,
  type MoneyOutcome,
} from '@domain/booking/lifecycle';

/**
 * The shape SELECT ... FOR UPDATE returns.
 *
 * Named rather than inlined into the generic. An inline type argument
 * that spans lines is fragile twice over: a formatter can move the
 * angle bracket away from the call, and a heredoc can swallow it.
 */
/** One row of the ticket query. Named, because a multi-line generic
 *  after $queryRaw gets eaten by the shell when this file is written
 *  through a heredoc. A line ending in "<" never survives. */
interface TicketRow {
  customer_id: string;
  status: string;
  tenant_id: string | null;
  pos_ticket_id: string | null;
  service_fils: bigint | null;
  captured_fils: bigint | null;
}

interface LockedBooking {
  branch_id: string;
  trading_day: Date;
  start_minute: number;
  duration_min: number;
  readonly id: string;
  readonly code: string;
  readonly status: BookingStatus;
  readonly start_at: Date;
}

/**
 * A settled ticket, already computed by the handler.
 *
 * The repository does not run the arithmetic: the handler owns the customer
 * and the tier, exactly as it owns the requirement at confirm. This is the
 * result, ready to persist.
 */
export interface SettlementWrite {
  readonly baseFils: number;
  readonly tipFils: number;
  readonly vatFils: number;
  readonly depositAppliedFils: number;
  readonly loyaltyRedeemFils: number;
  readonly dueFils: number;
  readonly creditFils: number;
  readonly taxExempt: boolean;
  readonly rail: string;
}

/** The transaction a transition runs in. */
type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * The ledger rows a POS payment leaves, already planned
 * (domain/pos/pos-settlement.ts), and the ticket they settle against.
 */
export interface PosSettlementWrite {
  readonly ticketId: string;
  /** "#T-42" */
  readonly ticketNumber: string;
  readonly applied: SettlementRow | null;
  readonly leftover: SettlementRow | null;
}

export interface TransitionInput {
  readonly bookingId: string;
  readonly to: BookingStatus;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly nowMs?: number;
  /** Present only on completed -> settled. */
  readonly settlement?: SettlementWrite;
  /**
   * Completed -> settled BY THE TILL (the paid callback, or the safety net
   * reading the ticket back). The POS already did the arithmetic; this only
   * records it. Mutually exclusive with `settlement`.
   */
  readonly posSettlement?: PosSettlementWrite;
  /**
   * Extra facts for the history row, beside the money outcome: what the
   * till paid with (ticket, receipt and invoice numbers).
   */
  readonly historyMetadata?: Record<string, unknown>;
  /** A salon-initiated cancel refunds in full, whatever the timing. */
  readonly initiatedBy?: CancelInitiator;
  readonly vipStandingReservation?: boolean;
  /**
   * THE AUTO NO-SHOW SWEEPER'S, AND NOBODY ELSE'S. Refuse (as illegal) when
   * the customer said they arrived: the booking's latest check-in request is
   * anything but rejected (check-in-request.repository.ts arrivalClaimed).
   *
   * Asked AFTER the row lock, because the sweeper picked this booking a
   * moment ago, outside any lock, and a raise may have committed since. A
   * raise takes the same lock, so here the answer is final.
   *
   * Absent everywhere else: the desk marking a no-show by hand is the desk
   * deciding, which is exactly what an unanswered request is waiting for.
   */
  readonly unlessArrivalClaimed?: boolean;
  /**
   * HOW a customer was checked in: on a move into CHECKED_IN, and only
   * there. Written to the history row as given, with NO DEFAULT: a check-in
   * without it, or another move with it, is refused by
   * booking_status_history_check_in_says_how.
   */
  readonly checkInVia?: CheckInVia;
}

export interface TransitionedBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  /**
   * 'unchanged' is not a PaymentStatus and is not meant to be: it says the
   * transition moved the booking without touching the money, which is a
   * different fact from any of the eight states and the one the desk needs
   * when it asks "was anything refunded?".
   */
  readonly paymentStatus: PaymentStatus | 'unchanged';
}

export type TransitionOutcome =
  | {
      readonly kind: 'transitioned';
      readonly booking: TransitionedBooking;
      readonly money: MoneyOutcome | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'needs_reason'; readonly message: string };

/** The booking as the paid callback locks it. */
interface PosLockedBooking {
  id: string;
  code: string;
  status: string;
  tenant_id: string | null;
  pos_ticket_id: string | null;
  net_fils: number | null;
  tax_fils: number | null;
  discount_fils: number | null;
}

export type PosSettleOutcome =
  | {
      readonly kind: 'settled';
      readonly code: string;
      /** The same ticket's payment, again: nothing was written. */
      readonly alreadySettled: boolean;
    }
  /** Settled already, by a different ticket. */
  | { readonly kind: 'settled_by_other'; readonly code: string }
  | { readonly kind: 'not_completed'; readonly status: string }
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly reason: string;
    }
  | Exclude<TransitionOutcome, { kind: 'transitioned' }>;

@Injectable()
export class LifecycleRepository {
  private static readonly log = new Logger(LifecycleRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One method for every lifecycle move: check in, start, complete, settle,
   * cancel, no-show.
   *
   * They all have the identical shape, which is only true because the state
   * machine is DATA rather than a switch. Six endpoints, one transaction,
   * one place where the audit row and the outbox event can be forgotten.
   *
   * The order inside matters:
   *   1. lock, so two conflicting commands cannot both apply
   *   2. decide legality against the CURRENT state, not the one the client saw
   *   3. write the status
   *   4. release capacity if this is an exit
   *   5. settle the money
   *   6. audit and event, in the same commit
   */
  /**
   * What the ticket is worth, before the register adds anything.
   *
   * Three facts, one round trip: the services actually delivered, the
   * customer the booking belongs to, and what has already been captured.
   *
   * The deposit comes from the LEDGER, not from booking.deposit_fils. The
   * ledger is the accounting truth: a partial refund or a goodwill credit
   * between confirm and checkout moves the real figure, and the booking row
   * still shows what was taken on the day.
   */
  async ticketFor(bookingId: string): Promise<{
    serviceFils: number;
    customerId: string;
    capturedFils: number;
    status: string;
    /** Whose booking: decides whether the till owns settling it. */
    tenantId: string | null;
    /** The till's ticket for the visit, when it opened one. */
    posTicketId: string | null;
  } | null> {
    const rows = await this.prisma.$queryRaw<TicketRow[]>`
      SELECT b.customer_id,
             b.status::text                       AS status,
             b.tenant_id,
             b.pos_ticket_id,
             (SELECT COALESCE(SUM(bi.price_fils), 0)
                FROM booking_item bi
               WHERE bi.booking_id = b.id)        AS service_fils,
             (SELECT COALESCE(SUM(dl.amount_fils), 0)
                FROM deposit_ledger dl
               WHERE dl.booking_id = b.id)        AS captured_fils
        FROM booking b
       WHERE b.id = ${bookingId}::uuid`;

    const row = rows[0];
    if (row === undefined) return null;

    return {
      customerId: row.customer_id,
      status: row.status,
      tenantId: row.tenant_id ?? null,
      posTicketId: row.pos_ticket_id ?? null,
      serviceFils: Number(row.service_fils ?? 0),
      capturedFils: Number(row.captured_fils ?? 0),
    };
  }

  /**
   * When this booking starts, and whose it is.
   *
   * Read for the day-of gates alone. `start_at` rather than `start_minute`
   * because both gates compare against NOW, and a minute-of-day cannot tell
   * today's 16:45 from Sunday's -- which is exactly how a booking two days
   * out was checked in and a no-show was taken six hours early.
   *
   * Also the party this booking is a lane of, and where that party was made
   * (`booking_group.source`, 'mobile' for the app), for the lifecycle
   * controller's party check (MOBILE_GROUP_LANE_GUARD). The same query: a
   * LEFT JOIN on the group's primary key, so a booking with no group, or a
   * group_id with no row behind it, comes back as before with both null.
   */
  async timingFor(bookingId: string): Promise<{
    startAtMs: number;
    customerId: string;
    groupId: string | null;
    groupSource: string | null;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      {
        start_at: Date;
        customer_id: string;
        group_id: string | null;
        group_source: string | null;
      }[]
    >`
      SELECT b.start_at, b.customer_id, b.group_id, g.source AS group_source
        FROM booking b
        LEFT JOIN booking_group g ON g.id = b.group_id
       WHERE b.id = ${bookingId}::uuid`;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          startAtMs: row.start_at.getTime(),
          customerId: row.customer_id,
          groupId: row.group_id,
          groupSource: row.group_source,
        };
  }

  async transition(input: TransitionInput): Promise<TransitionOutcome> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.transitionWithin(tx, input),
      );
    } catch (e) {
      LifecycleRepository.log.error(
        `transition() failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`,
      );
      throw e;
    }
  }

  /**
   * The paid callback from the POS: the till took the balance, so the visit
   * is settled (gostyle-platform docs/booking-pos-tickets-plan.md, B6).
   *
   * IDEMPOTENT ON THE TICKET, and answered under the booking's lock before
   * anything is decided: the platform's outbox retries the callback and the
   * safety net replays it from the ticket, so the same payment arrives more
   * than once by design. The same ticket again answers `already`; another
   * ticket for a booking already settled is a conflict for a person.
   *
   * Then the ordinary transition, in the same transaction, so the history
   * row, the booking.settled event and the ledger rows are one commit: the
   * deposit draw-down (applied_at_pos, which the till already posted) and
   * any leftover credited to the wallet, each carrying the VAT split that
   * lands CUSTOMER_DEPOSITS on zero (domain/pos/pos-settlement.ts).
   */
  async settleFromPos(input: {
    readonly tenantId: string;
    readonly bookingId: string;
    readonly ticketId: string;
    readonly ticketNumber: string;
    readonly cashierId: string;
    readonly depositAppliedFils: number;
    readonly depositAppliedVatFils: number;
    readonly historyMetadata: Record<string, unknown>;
  }): Promise<PosSettleOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<PosLockedBooking[]>`
          SELECT id, code, status::text AS status, tenant_id, pos_ticket_id,
                 net_fils, tax_fils, discount_fils
            FROM booking
           WHERE id = ${input.bookingId}::uuid
           FOR UPDATE`;
        const b = locked[0];
        // Another tenant's booking is no booking at all, to this caller.
        if (b === undefined || b.tenant_id !== input.tenantId) {
          return { kind: 'not_found' as const };
        }

        if (b.status === 'settled') {
          const applied = await tx.depositLedger.findFirst({
            where: {
              bookingId: b.id,
              entryType: 'applied_at_pos',
              posTransactionId: input.ticketId,
            },
            select: { id: true },
          });
          const same = b.pos_ticket_id === input.ticketId || applied !== null;
          return same
            ? { kind: 'settled' as const, code: b.code, alreadySettled: true }
            : { kind: 'settled_by_other' as const, code: b.code };
        }

        if (b.status !== 'completed') {
          return { kind: 'not_completed' as const, status: b.status };
        }

        // What the booking holds now, split as the journal declared it.
        const rows = await tx.depositLedger.findMany({
          where: { bookingId: b.id },
          select: { entryType: true, amountFils: true, vatFils: true },
        });
        const position = depositPosition(
          rows.map((r) => ({
            entryType: r.entryType,
            amountFils: r.amountFils,
            vatFils: r.vatFils,
          })),
          {
            netFils: b.net_fils,
            taxFils: b.tax_fils,
            discountFils: b.discount_fils,
          },
        );
        const plan = planPosSettlement(position, {
          appliedFils: input.depositAppliedFils,
          appliedVatFils: input.depositAppliedVatFils,
        });
        if (plan.kind === 'refused') {
          return {
            kind: 'refused' as const,
            code: plan.code,
            reason: plan.reason,
          };
        }

        const outcome = await this.transitionWithin(tx, {
          bookingId: b.id,
          to: 'settled',
          actor: 'staff',
          actorId: input.cashierId,
          reason: `Paid at the till, ticket ${input.ticketNumber}`,
          posSettlement: {
            ticketId: input.ticketId,
            ticketNumber: input.ticketNumber,
            applied: plan.applied,
            leftover: plan.leftover,
          },
          historyMetadata: input.historyMetadata,
        });
        if (outcome.kind !== 'transitioned') return outcome;
        return {
          kind: 'settled' as const,
          code: b.code,
          alreadySettled: false,
        };
      });
    } catch (e) {
      LifecycleRepository.log.error(
        `settleFromPos(${input.bookingId.slice(0, 8)}, ticket ` +
          `${input.ticketNumber}) failed: ` +
          `${e instanceof Error ? e.message.slice(0, 400) : String(e)}`,
      );
      throw e;
    }
  }

  /**
   * The transition itself, inside a transaction the caller owns, so a move
   * can share its commit with whatever decided it (settleFromPos).
   */
  async transitionWithin(
    tx: Tx,
    input: TransitionInput,
  ): Promise<TransitionOutcome> {
    const nowMs = input.nowMs ?? Date.now();
    // 1. Row lock. When the desk marks a no-show while the customer taps
    //    a self-scan check-in, exactly one of them wins and the loser
    //    reads fresh state rather than silently overwriting.
    const locked = await tx.$queryRaw<LockedBooking[]>`
      SELECT id, code, status, start_at, branch_id, trading_day,
             start_minute, duration_min
        FROM booking
       WHERE id = ${input.bookingId}::uuid
       FOR UPDATE`;

    const booking = locked[0];
    if (booking === undefined) return { kind: 'not_found' as const };

    // 1b. Self check-in. Only the sweeper asks (unlessArrivalClaimed).
    if (input.unlessArrivalClaimed === true) {
      const claim = await tx.$queryRaw<{ claimed: boolean }[]>`
        SELECT ${arrivalClaimed(Prisma.sql`${booking.id}::uuid`)} AS claimed`;
      if (claim[0]?.claimed === true) {
        return {
          kind: 'illegal' as const,
          message:
            `${booking.code}: the customer said they arrived, ` +
            'so the desk decides.',
        };
      }
    }

    // 2. Legality is judged against what the database says NOW, not
    //    against whatever the client had on screen a minute ago.
    const verdict = checkTransition({
      from: booking.status,
      to: input.to,
      actor: input.actor,
      reason: input.reason,
    });
    if (verdict.kind !== 'allowed') {
      return { kind: verdict.kind, message: verdict.message };
    }

    // 3. Money, decided before anything is applied, so the outcome can be
    //    read back to the customer and stored verbatim.
    const money = await this.settleMoney(tx, {
      bookingId: booking.id,
      to: input.to,
      startAtMs: booking.start_at.getTime(),
      nowMs,
      initiatedBy: input.initiatedBy ?? 'customer',
      ...(input.vipStandingReservation !== undefined
        ? { vipStandingReservation: input.vipStandingReservation }
        : {}),
      actor: input.actor,
      actorId: input.actorId,
    });

    // 3b. Settlement. The deposit is TENDER: it is consumed by the
    //     ticket, not refunded, so it leaves the ledger as
    //     applied_at_pos. Anything the ticket did not need goes back as
    //     credit, which is why both entries are negative and the
    //     booking's protected balance lands on zero either way.
    //
    //     Tips and retail never touch THIS ledger. It tracks the deposit,
    //     and a tip is a fresh charge at the till.
    if (input.settlement !== undefined) {
      const st = input.settlement;
      const applied = st.depositAppliedFils - st.creditFils;

      if (applied > 0) {
        await tx.depositLedger.create({
          data: {
            bookingId: booking.id,
            entryType: 'applied_at_pos',
            amountFils: -applied,
            rail: 'internal',
            reason: `Applied to ticket ${booking.code}`,
            actorKind: input.actor,
            actorId:
              input.actor === 'system' || input.actorId === null
                ? null
                : toUuid(input.actorId),
          },
        });
      }

      if (st.creditFils > 0) {
        await tx.depositLedger.create({
          data: {
            bookingId: booking.id,
            entryType: 'refunded',
            amountFils: -st.creditFils,
            rail: 'internal',
            reason: 'Overpayment credited to the wallet',
            actorKind: input.actor,
            actorId:
              input.actor === 'system' || input.actorId === null
                ? null
                : toUuid(input.actorId),
          },
        });
      }
    }

    // 3c. Settled by the till. The arithmetic is the POS's and was
    //     planned by the caller; this records it. Both rows name the
    //     ticket. The draw-down is the till's to post (the journal skips
    //     it); the leftover goes back to the wallet with exactly the VAT
    //     the till did not reverse (vat_fils).
    if (input.posSettlement !== undefined) {
      const ps = input.posSettlement;
      const actorId =
        input.actor === 'system' || input.actorId === null
          ? null
          : toUuid(input.actorId);
      if (ps.applied !== null) {
        await tx.depositLedger.create({
          data: {
            bookingId: booking.id,
            entryType: 'applied_at_pos',
            amountFils: ps.applied.amountFils,
            vatFils: ps.applied.vatFils,
            rail: 'internal',
            posTransactionId: ps.ticketId,
            reason: `Applied to POS ticket ${ps.ticketNumber}`,
            actorKind: input.actor,
            actorId,
          },
        });
      }
      if (ps.leftover !== null) {
        await tx.depositLedger.create({
          data: {
            bookingId: booking.id,
            entryType: 'refunded',
            amountFils: ps.leftover.amountFils,
            vatFils: ps.leftover.vatFils,
            rail: 'internal',
            posTransactionId: ps.ticketId,
            reason:
              `Deposit left after POS ticket ${ps.ticketNumber}, ` +
              'credited to the wallet',
            actorKind: input.actor,
            actorId,
          },
        });
      }
    }

    const paymentStatus = nextPaymentStatus(money);

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: input.to,
        ...(paymentStatus !== null ? { paymentStatus } : {}),
        // The ticket that paid is the booking's ticket, whatever the
        // sync last stored: the money was taken on it.
        ...(input.posSettlement !== undefined
          ? {
              posTicketId: input.posSettlement.ticketId,
              posTicketNumber: input.posSettlement.ticketNumber,
            }
          : {}),
      },
    });

    // The items, read once. The capacity release needs their ids and the
    // event needs the first one's service and professional, so a single
    // read serves both rather than one conditional read and one more
    // later.
    const items = await tx.bookingItem.findMany({
      where: { bookingId: booking.id },
      select: { id: true, serviceId: true, staffId: true },
      orderBy: { position: 'asc' },
    });
    const firstItem = items[0];

    // 4. THE LINE THAT RETURNS CAPACITY.
    //    Never delete a reservation: history survives, the time becomes
    //    sellable, and the row leaves the exclusion constraint's
    //    WHERE (blocking) filter in the same statement.
    if (releasesCapacity(input.to)) {
      const itemIds = items.map((i) => i.id);
      if (itemIds.length > 0) {
        await tx.staffReservation.updateMany({
          where: { bookingItemId: { in: itemIds } },
          data: { blocking: false },
        });
        await tx.resourceReservation.updateMany({
          where: { bookingItemId: { in: itemIds } },
          data: { blocking: false },
        });
      }
    }

    // 5. Audit. The CHECK constraints from step 3 enforce that a system
    //    action has no human actor and a manager override has a reason.
    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: input.to,
        reason: input.reason,
        metadata:
          money === null && input.historyMetadata === undefined
            ? undefined
            : {
                ...(money ?? {}),
                ...(input.historyMetadata ?? {}),
              },
        actorKind: input.actor,
        actorId:
          input.actor === 'system' || input.actorId === null
            ? null
            : toUuid(input.actorId),
        // As the caller said, or nothing: never a default (the CHECK).
        checkInVia: input.checkInVia ?? null,
      },
    });

    // 6. The event, same commit. The waitlist and the reminder scheduler
    //    both hang off this, and neither may be lost.
    await tx.eventOutbox.create({
      data: {
        aggregateType: 'booking',
        aggregateId: booking.id,
        // The in-service event is named session.started, not booking.in_service.
        // Everything else follows booking.<status>.
        eventType:
          input.to === 'in_service' ? 'session.started' : `booking.${input.to}`,
        payload: {
          code: booking.code,
          from: booking.status,
          to: input.to,
          refundFils: money?.refundFils ?? 0,
          keptFils: money?.keptFils ?? 0,
          releasedCapacity: releasesCapacity(input.to),
          // WHAT was freed, not just that something was.
          //
          // A consumer that only learns "GS-1050 was cancelled" has to go
          // and fetch the booking before it can do anything, which defeats
          // the point of publishing an event at all. The waitlist needs
          // exactly these five fields to find a candidate.
          branchId: booking.branch_id,
          tradingDay: booking.trading_day.toISOString().slice(0, 10),
          startMin: booking.start_minute,
          durationMin: booking.duration_min,
          ...(firstItem !== undefined
            ? {
                serviceId: firstItem.serviceId,
                staffId: firstItem.staffId,
              }
            : {}),
        },
      },
    });

    return {
      kind: 'transitioned' as const,
      booking: {
        bookingId: booking.id,
        code: booking.code,
        from: booking.status,
        to: input.to,
        paymentStatus: paymentStatus ?? 'unchanged',
      },
      money,
    };
  }

  /**
   * Only cancel and no-show move money. Everything else on the happy path
   * leaves the ledger alone.
   *
   * Corrections are new rows, never edits: the append-only trigger from
   * step 3 would reject an UPDATE outright.
   */
  private async settleMoney(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    input: {
      bookingId: string;
      to: BookingStatus;
      startAtMs: number;
      nowMs: number;
      initiatedBy: CancelInitiator;
      vipStandingReservation?: boolean;
      actor: ActorKind;
      actorId: string | null;
    },
  ): Promise<MoneyOutcome | null> {
    if (input.to !== 'cancelled' && input.to !== 'no_show') return null;

    // The protected balance is simply the sum. That is the whole reason the
    // ledger stores signed amounts rather than a separate balance column
    // that could drift.
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT COALESCE(SUM(amount_fils), 0) AS balance
        FROM deposit_ledger
       WHERE booking_id = ${input.bookingId}::uuid`;
    const captured = Number(rows[0]?.balance ?? 0);

    const outcome =
      input.to === 'no_show'
        ? noShowOutcome({
            capturedFils: captured,
            ...(input.vipStandingReservation !== undefined
              ? { vipStandingReservation: input.vipStandingReservation }
              : {}),
          })
        : cancellationOutcome({
            nowMs: input.nowMs,
            startAtMs: input.startAtMs,
            capturedFils: captured,
            paidInFull: false,
            initiatedBy: input.initiatedBy,
          });

    const actorKind = input.actor === 'system' ? 'system' : input.actor;
    const actorId =
      input.actor === 'system' || input.actorId === null
        ? null
        : toUuid(input.actorId);

    // Two entries at most, both negative, because money is leaving the
    // protected balance in both directions. The entry TYPE is what tells
    // finance whether it went back to the customer or stayed with the salon.
    if (outcome.refundFils > 0) {
      await tx.depositLedger.create({
        data: {
          bookingId: input.bookingId,
          entryType: 'refunded',
          amountFils: -outcome.refundFils,
          rail: 'internal',
          reason: outcome.explanation,
          actorKind,
          actorId,
        },
      });
    }
    if (outcome.keptFils > 0) {
      await tx.depositLedger.create({
        data: {
          bookingId: input.bookingId,
          entryType: 'forfeited',
          amountFils: -outcome.keptFils,
          rail: 'internal',
          reason: outcome.explanation,
          actorKind,
          actorId,
        },
      });
    }

    return outcome;
  }
}

/** Where the money ended up, in one word, for the booking row. */
function nextPaymentStatus(
  money: MoneyOutcome | null,
): 'refunded' | 'forfeited' | 'partially_refunded' | null {
  if (money === null) return null;
  if (money.refundFils > 0 && money.keptFils > 0) return 'partially_refunded';
  if (money.refundFils > 0) return 'refunded';
  if (money.keptFils > 0) return 'forfeited';
  return null;
}
