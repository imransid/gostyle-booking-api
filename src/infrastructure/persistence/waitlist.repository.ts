import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import { SlugIndex } from './slug-uuid';
import { STAFF_SLUGS } from '../fixtures/fixture-booking-context';
import {
  planOffer,
  decline as declineRule,
  OFFER_TTL_MS,
  type FreedSlot,
  type WaitlistEntry,
} from '@domain/booking/waitlist';

/** Named: a heredoc eats a line ending in `<`. */
interface EntryRow {
  id: string;
  customer_id: string;
  service_id: string;
  trading_day: Date;
  window_from_min: number;
  window_to_min: number;
  preferred_staff_id: string | null;
  decline_count: number;
  declined_codes: string[];
  joined_at: Date;
}

interface OfferRow {
  branch_id: string;
  customer_id: string;
  offered_booking_code: string;
  trading_day: Date;
  start_minute: number;
  duration_min: number;
  service_id: string;
  staff_id: string;
}

interface LapsedRow {
  id: string;
  branch_id: string;
  offered_booking_code: string | null;
  customer_id: string;
}

interface SlotRow {
  code: string;
  trading_day: Date;
  start_minute: number;
  duration_min: number;
  service_id: string;
  staff_id: string;
}

export interface OfferResult {
  readonly offered: boolean;
  readonly entryId?: string;
  readonly customerId?: string;
  readonly expiresAtMs?: number;
  readonly queueLength: number;
  readonly passedOver: number;
}

@Injectable()
export class WaitlistRepository {
  private static readonly log = new Logger(WaitlistRepository.name);

  /** booking_item.staff_id is a uuid; placeHold expects a slug. */
  private readonly staff = new SlugIndex(STAFF_SLUGS);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Offer a freed slot to the top candidate.
   *
   * THE PROBLEM THIS SOLVES. Two replicas both see booking GS-1050 cancelled
   * and both run this. Without care they offer the same slot to two people,
   * both tap "Book now", and one of them is told the slot is gone by a system
   * that just invited them to take it.
   *
   * The fix is the same shape as the reminder claim: the winning entry is
   * moved to 'offered' by an UPDATE with a WHERE that only the first
   * transaction can satisfy. The second replica's update matches zero rows,
   * it sees the slot is already spoken for, and it stops.
   *
   * The CANDIDATES are read under FOR UPDATE SKIP LOCKED so the two replicas
   * do not deadlock waiting on each other's rows.
   */
  async offerFreedSlot(
    branchId: string,
    slot: FreedSlot,
    nowMs: number = Date.now(),
  ): Promise<OfferResult> {
    return this.prisma.$transaction(async (tx) => {
      // Everyone still live for this service on this day. The partial index
      // makes this a small read even on a busy branch.
      const rows = await tx.$queryRaw<EntryRow[]>`
        SELECT id, customer_id, service_id, trading_day,
               window_from_min, window_to_min, preferred_staff_id,
               decline_count, declined_codes, joined_at
          FROM waitlist_entry
         WHERE branch_id = ${branchId}::uuid
           AND trading_day = ${slot.tradingDay}::date
           AND service_id = ${slot.serviceId}
           AND status = 'waiting'
         ORDER BY joined_at
         FOR UPDATE SKIP LOCKED`;

      // The tier is not on the waitlist row: it belongs to the customer and
      // would go stale the moment they were upgraded. Ranking is a domain
      // decision, so the rows are shaped for the domain and handed over.
      const entries: WaitlistEntry[] = rows.map((r) => ({
        id: r.id,
        customerId: r.customer_id,
        serviceId: r.service_id,
        tradingDay: slot.tradingDay,
        windowFromMin: r.window_from_min,
        windowToMin: r.window_to_min,
        preferredStaffId: r.preferred_staff_id,
        // Filled by the handler, which owns the customer reader. 'none' here
        // only ever affects a tie-break that the spec says never fires.
        tier: 'none',
        joinedAtMs: r.joined_at.getTime(),
        declineCount: r.decline_count,
        declinedCodes: r.declined_codes,
      }));

      const plan = planOffer(entries, slot, nowMs);

      if (plan.offerTo === null) {
        WaitlistRepository.log.log(
          `${slot.bookingCode} freed: nobody waiting (${plan.passedOver.length} passed over)`,
        );
        return {
          offered: false,
          queueLength: 0,
          passedOver: plan.passedOver.length,
        };
      }

      const winner = plan.offerTo;
      const expiresAt = new Date(nowMs + OFFER_TTL_MS);

      // THE CLAIM. status = 'waiting' in the WHERE is what makes this safe:
      // only the first transaction to commit finds the row waiting, and the
      // second updates nothing.
      const claimed = await tx.waitlistEntry.updateMany({
        where: { id: winner.id, status: 'waiting' },
        data: {
          status: 'offered',
          offeredBookingCode: slot.bookingCode,
          offerExpiresAt: expiresAt,
        },
      });

      if (claimed.count === 0) {
        // Another replica got there first. Not an error: the slot is being
        // offered, just not by us.
        return {
          offered: false,
          queueLength: plan.candidates.length,
          passedOver: plan.passedOver.length,
        };
      }

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'waitlist',
          aggregateId: winner.id,
          eventType: 'waitlist.offered',
          payload: {
            bookingCode: slot.bookingCode,
            customerId: winner.customerId,
            serviceId: slot.serviceId,
            tradingDay: slot.tradingDay,
            startMin: slot.startMin,
            staffId: slot.staffId,
            expiresAt: expiresAt.toISOString(),
            // How many are behind them, so the message can say so.
            queueLength: plan.candidates.length,
          },
        },
      });

      WaitlistRepository.log.log(
        `${slot.bookingCode} offered to ${winner.customerId} (${plan.candidates.length} in queue)`,
      );

      return {
        offered: true,
        entryId: winner.id,
        customerId: winner.customerId,
        expiresAtMs: expiresAt.getTime(),
        queueLength: plan.candidates.length,
        passedOver: plan.passedOver.length,
      };
    });
  }

  /**
   * Join the list.
   *
   * The position is counted at join time as a courtesy, not stored: it is
   * true when the message goes out and stale a minute later, because people
   * ahead can be served, decline out, or leave. Storing it would invite
   * someone to trust it.
   */
  async join(input: {
    branchId: string;
    customerId: string;
    serviceId: string;
    tradingDay: string;
    windowFromMin: number;
    windowToMin: number;
    preferredStaffId: string | null;
  }): Promise<{ entryId: string; position: number }> {
    const entry = await this.prisma.waitlistEntry.create({
      data: {
        branchId: toUuid(input.branchId),
        customerId: toUuid(input.customerId),
        // The SAME normalisation booking_item gets. The catalogue speaks
        // slugs ("full-colour") and the column is a uuid, so confirm folds
        // the slug through toUuid on the way in. Storing the raw slug here
        // meant the waitlist held "full-colour" while the freed-slot event
        // carried the hash, and matches() compared two spellings of the same
        // service and rejected everyone.
        //
        // This disappears the day the catalogue speaks real uuids.
        serviceId: toUuid(input.serviceId),
        tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
        windowFromMin: input.windowFromMin,
        windowToMin: input.windowToMin,
        preferredStaffId:
          input.preferredStaffId === null
            ? null
            : toUuid(input.preferredStaffId),
      },
    });

    const ahead = await this.prisma.waitlistEntry.count({
      where: {
        branchId: toUuid(input.branchId),
        tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
        serviceId: toUuid(input.serviceId),
        status: { in: ['waiting', 'offered'] },
        joinedAt: { lt: entry.joinedAt },
      },
    });

    WaitlistRepository.log.log(
      `${input.customerId} joined for ${input.serviceId} on ${input.tradingDay} (${ahead} ahead)`,
    );
    return { entryId: entry.id, position: ahead + 1 };
  }

  /**
   * The offer on this entry, if it is still live.
   *
   * Null covers three cases that look different to us and identical to the
   * customer: never offered, already lapsed, already answered. All three mean
   * "that slot is not yours to take", and distinguishing them in the response
   * would only tell a stranger which entry ids exist.
   */
  async liveOffer(entryId: string): Promise<{
    branchId: string;
    customerId: string;
    bookingCode: string;
    serviceId: string;
    tradingDay: string;
    startMin: number;
    durationMin: number;
    staffId: string;
  } | null> {
    const rows = await this.prisma.$queryRaw<OfferRow[]>`
      SELECT w.branch_id, w.customer_id, w.offered_booking_code,
             b.trading_day, b.start_minute, b.duration_min,
             bi.service_id, bi.staff_id
        FROM waitlist_entry w
        JOIN booking b  ON b.code = w.offered_booking_code
        JOIN booking_item bi ON bi.booking_id = b.id
       WHERE w.id = ${entryId}::uuid
         AND w.status = 'offered'
         AND w.offer_expires_at > now()
       ORDER BY bi.position
       LIMIT 1`;

    const r = rows[0];
    if (r === undefined) return null;

    return {
      branchId: r.branch_id,
      customerId: r.customer_id,
      bookingCode: r.offered_booking_code,
      serviceId: r.service_id,
      tradingDay: r.trading_day.toISOString().slice(0, 10),
      startMin: r.start_minute,
      durationMin: r.duration_min,
      staffId: this.staff.toSlug(r.staff_id),
    };
  }

  /**
   * Taken.
   *
   * status = 'offered' in the WHERE is the claim: if the sweeper lapsed this
   * offer a millisecond ago, or the customer double-tapped, the second write
   * matches nothing and the caller is told the offer is gone rather than
   * being handed a slot twice.
   */
  async markAccepted(entryId: string): Promise<boolean> {
    const done = await this.prisma.waitlistEntry.updateMany({
      where: { id: entryId, status: 'offered' },
      data: {
        status: 'accepted',
        offeredBookingCode: null,
        offerExpiresAt: null,
      },
    });
    return done.count > 0;
  }

  /**
   * Offers that ran out of time.
   *
   * WITHOUT THIS THE QUEUE STALLS. The pass-down only happens on a decline,
   * and most people do not decline: they ignore the message. One silent
   * candidate would hold a freed slot until the day itself, with three more
   * people behind them who would have taken it.
   *
   * A lapse is treated exactly as a decline, including the fairness cap,
   * because a customer who never answers is absorbing offers just as surely
   * as one who says no.
   */
  async sweepExpiredOffers(nowMs: number = Date.now()): Promise<number> {
    // Claimed the same way as everything else: the UPDATE moves them out of
    // 'offered' so a second replica finds nothing to sweep.
    const lapsed = await this.prisma.$queryRaw<LapsedRow[]>`
      UPDATE waitlist_entry
         SET status = 'waiting'
       WHERE id IN (
         SELECT id FROM waitlist_entry
          WHERE status = 'offered'
            AND offer_expires_at <= ${new Date(nowMs)}
          ORDER BY offer_expires_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, branch_id, offered_booking_code, customer_id`;

    let passed = 0;
    for (const row of lapsed) {
      if (row.offered_booking_code === null) continue;

      // The slot has to be rebuilt from the booking, because the waitlist row
      // only remembers which code it was offered. If the booking has since
      // been rebooked by someone else there is nothing to pass down, which is
      // the right answer rather than an error.
      const slot = await this.slotForCode(row.offered_booking_code);
      if (slot === null) {
        await this.prisma.waitlistEntry.update({
          where: { id: row.id },
          data: { offeredBookingCode: null, offerExpiresAt: null },
        });
        continue;
      }

      await this.passDown(row.id, row.branch_id, slot, nowMs);
      passed += 1;
    }

    if (passed > 0) {
      WaitlistRepository.log.log(`${passed} offer(s) lapsed and passed down`);
    }
    return passed;
  }

  /** Rebuild a freed slot from the booking that freed it. */
  private async slotForCode(code: string): Promise<FreedSlot | null> {
    const rows = await this.prisma.$queryRaw<SlotRow[]>`
      SELECT b.code, b.trading_day, b.start_minute, b.duration_min,
             bi.service_id, bi.staff_id
        FROM booking b
        JOIN booking_item bi ON bi.booking_id = b.id
       WHERE b.code = ${code}
       ORDER BY bi.position
       LIMIT 1`;

    const r = rows[0];
    if (r === undefined) return null;

    return {
      bookingCode: r.code,
      serviceId: r.service_id,
      tradingDay: r.trading_day.toISOString().slice(0, 10),
      startMin: r.start_minute,
      durationMin: r.duration_min,
      staffId: this.staff.toSlug(r.staff_id),
    };
  }

  /**
   * A decline, or a lapsed offer. Both pass the slot down.
   *
   * The booking code goes on declinedCodes so the same slot is never offered
   * to the same person twice, even if it frees up again later.
   */
  async passDown(
    entryId: string,
    branchId: string,
    slot: FreedSlot,
    nowMs: number = Date.now(),
  ): Promise<OfferResult> {
    const entry = await this.prisma.waitlistEntry.findUnique({
      where: { id: entryId },
    });
    if (entry === null) {
      return { offered: false, queueLength: 0, passedOver: 0 };
    }

    const outcome = declineRule({
      id: entry.id,
      customerId: entry.customerId,
      serviceId: entry.serviceId,
      tradingDay: slot.tradingDay,
      windowFromMin: entry.windowFromMin,
      windowToMin: entry.windowToMin,
      preferredStaffId: entry.preferredStaffId,
      tier: 'none',
      joinedAtMs: entry.joinedAt.getTime(),
      declineCount: entry.declineCount,
      declinedCodes: entry.declinedCodes,
    });

    await this.prisma.waitlistEntry.update({
      where: { id: entryId },
      data: {
        // The cap constraint forbids a waiting row past three declines, so
        // the status and the counter have to move together.
        status: outcome.kind === 'leaves_list' ? 'left' : 'waiting',
        declineCount: outcome.declineCount,
        declinedCodes: { push: slot.bookingCode },
        offeredBookingCode: null,
        offerExpiresAt: null,
      },
    });

    if (outcome.kind === 'leaves_list') {
      WaitlistRepository.log.log(
        `${entry.customerId} left the waitlist after ${outcome.declineCount} declines`,
      );
    }

    // The slot is free again. Whoever is next in the queue gets it.
    return this.offerFreedSlot(branchId, slot, nowMs);
  }
}
