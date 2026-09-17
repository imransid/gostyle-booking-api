import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid, branchInstant } from './hold.repository';
import { canUndoCheckIn, shortenTo } from '@domain/booking/lifecycle';
import type { ActorKind } from '@domain/booking/lifecycle';

/**
 * The desk actions that were listed in the contract and had no home.
 *
 * Undo, shorten, waiver and the manual reminder. Each is small; what they
 * share is that every one of them has to leave an AUDIT TRAIL, because each
 * either releases capacity somebody else is queuing for or bypasses a safety
 * gate. They all write to booking_status_history, which already carries the
 * actor and the reason, rather than inventing a second audit table.
 */

export type ExtraOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  | { readonly kind: 'done'; readonly code: string; readonly detail: unknown };

@Injectable()
export class DeskExtrasRepository {
  private static readonly log = new Logger(DeskExtrasRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * §11.2 Undo a check-in, valid for five minutes.
   *
   * THE CHAIR IS RELEASED. A check-in that is undone but keeps the chair is
   * the worst of both: the customer is not here and the station still reads
   * as busy.
   */
  async undoCheckIn(input: {
    readonly bookingId: string;
    readonly reason: string;
    readonly actor: ActorKind;
    readonly actorId: string | null;
    readonly nowMs?: number;
  }): Promise<ExtraOutcome> {
    const nowMs = input.nowMs ?? Date.now();

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; code: string; status: string }[]
      >`
        SELECT id, code, status::text AS status FROM booking
         WHERE id = ${input.bookingId}::uuid FOR UPDATE`;
      const b = rows[0];
      if (b === undefined) return { kind: 'not_found' as const };

      if (b.status !== 'checked_in') {
        return {
          kind: 'illegal' as const,
          message: `Only a checked-in booking can be undone; this one is ${b.status}.`,
        };
      }

      // WHEN it was checked in comes from the history, not from a column:
      // the transition already recorded it, and a second timestamp on the
      // booking would be a copy that can disagree.
      const marks = await tx.bookingStatusHistory.findFirst({
        where: { bookingId: b.id, toStatus: 'checked_in' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const verdict = canUndoCheckIn({
        checkedInAtMs: (marks?.createdAt ?? new Date(0)).getTime(),
        nowMs,
      });
      if (verdict.kind === 'too_late') {
        return {
          kind: 'illegal' as const,
          message:
            `That check-in was ${verdict.minutesAgo} minutes ago. ` +
            'Past five minutes, cancel the visit or start it — undoing it now ' +
            'would say the customer never arrived.',
        };
      }

      await tx.$executeRaw`
        UPDATE booking SET status = 'confirmed', updated_at = now()
         WHERE id = ${b.id}::uuid`;

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: b.id,
          fromStatus: 'checked_in',
          toStatus: 'confirmed',
          reason: input.reason,
          actorKind: input.actor,
          actorId: actorUuid(input),
        },
      });

      DeskExtrasRepository.log.log(`${b.code} check-in undone`);
      return {
        kind: 'done' as const,
        code: b.code,
        detail: { status: 'CONFIRMED' },
      };
    });
  }

  /**
   * §11.2 Shorten a late arrival to what still fits.
   *
   * THE RESERVATIONS SHRINK WITH IT. Shortening the booking row alone would
   * leave the chair and the professional blocked for the original span, so
   * the minutes freed would be freed on paper only -- and the whole point is
   * to hand them back to the diary.
   */
  async shorten(input: {
    readonly bookingId: string;
    readonly toDurationMin: number;
    readonly reason: string;
    readonly actor: ActorKind;
    readonly actorId: string | null;
  }): Promise<ExtraOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          code: string;
          status: string;
          duration_min: number;
          start_minute: number;
          trading_day: Date;
        }[]
      >`
        SELECT id, code, status::text AS status, duration_min, start_minute, trading_day
          FROM booking WHERE id = ${input.bookingId}::uuid FOR UPDATE`;
      const b = rows[0];
      if (b === undefined) return { kind: 'not_found' as const };

      if (b.status !== 'confirmed' && b.status !== 'checked_in') {
        return {
          kind: 'illegal' as const,
          message: `A ${b.status} booking cannot be shortened.`,
        };
      }

      const to = shortenTo({
        originalMin: b.duration_min,
        requestedMin: input.toDurationMin,
      });
      if (to === null) {
        return {
          kind: 'illegal' as const,
          message:
            `${input.toDurationMin} minutes does not work: a shortened visit ` +
            `must be under the original ${b.duration_min} and at least 15 ` +
            'minutes. Rebook or record a no-show instead.',
        };
      }

      const day = b.trading_day.toISOString().slice(0, 10);
      const newEnd = branchInstant(day, b.start_minute + to);

      await tx.$executeRaw`
        UPDATE booking
           SET duration_min = ${to}, end_at = ${newEnd}, updated_at = now()
         WHERE id = ${b.id}::uuid`;

      // The reservations are what actually hold the capacity.
      await tx.$executeRaw`
        UPDATE staff_reservation
           SET duration_min = ${to}, end_at = ${newEnd}
         WHERE booking_item_id IN (
           SELECT id FROM booking_item WHERE booking_id = ${b.id}::uuid)`;
      await tx.$executeRaw`
        UPDATE resource_reservation
           SET duration_min = ${to}, end_at = ${newEnd}
         WHERE booking_item_id IN (
           SELECT id FROM booking_item WHERE booking_id = ${b.id}::uuid)`;

      /**
       * AN EVENT, NOT A TRANSITION.
       *
       * The first version wrote this to booking_status_history with the same
       * from and to, and `bsh_actually_moved` refused it -- correctly. That
       * table records MOVEMENT between states, and a shortened visit has not
       * moved; a row claiming confirmed -> confirmed would be noise in the
       * one place a human goes to read what happened to a booking.
       *
       * The outbox is where things that HAPPENED live, with a payload, and
       * it is already relayed to anyone who cares.
       */
      await tx.eventOutbox.create({
        data: {
          aggregateType: 'booking',
          aggregateId: b.id,
          eventType: 'booking.shortened',
          payload: {
            code: b.code,
            fromDurationMin: b.duration_min,
            toDurationMin: to,
            releasedMin: b.duration_min - to,
            reason: input.reason,
            actorKind: input.actor,
            actorId: input.actorId,
          },
        },
      });

      DeskExtrasRepository.log.log(
        `${b.code} shortened ${b.duration_min} -> ${to} min`,
      );
      return {
        kind: 'done' as const,
        code: b.code,
        detail: {
          fromDurationMinutes: b.duration_min,
          toDurationMinutes: to,
          releasedMinutes: b.duration_min - to,
        },
      };
    });
  }

  /**
   * §11.2 Record a patch-test waiver. Manager only.
   *
   * WRITTEN TO THE AUDIT TRAIL, not to a flag on the booking. A manager
   * overriding a safety gate is an EVENT with a person and a reason attached,
   * and the question support will ask months later is "who waived it and
   * why", which a boolean cannot answer.
   */
  async waiver(input: {
    readonly bookingId: string;
    readonly reason: string;
    readonly actor: ActorKind;
    readonly actorId: string | null;
  }): Promise<ExtraOutcome> {
    const rows = await this.prisma.$queryRaw<
      { id: string; code: string; status: string }[]
    >`
      SELECT id, code, status::text AS status FROM booking
       WHERE id = ${input.bookingId}::uuid`;
    const b = rows[0];
    if (b === undefined) return { kind: 'not_found' };

    // An event, for the same reason as the shorten above: nothing moved
    // between states, and bsh_actually_moved exists to keep that table
    // readable as a history rather than a log of everything.
    await this.prisma.eventOutbox.create({
      data: {
        aggregateType: 'booking',
        aggregateId: b.id,
        eventType: 'booking.patch_test_waived',
        payload: {
          code: b.code,
          reason: input.reason,
          actorKind: input.actor,
          waivedBy: input.actorId,
        },
      },
    });

    DeskExtrasRepository.log.warn(
      `${b.code} patch-test WAIVED by ${input.actorId ?? 'unknown'}: ${input.reason}`,
    );
    return {
      kind: 'done',
      code: b.code,
      detail: { waiver: 'PATCH_TEST', recordedAt: new Date().toISOString() },
    };
  }

  /**
   * §7.1 Send the confirm-or-move reminder now.
   *
   * Marks the 24-hour rung and writes the outbox event the scheduler would
   * have written, so a manual send and an automatic one are the SAME event
   * downstream. `queuedUntil` is set when quiet hours pushed it.
   */
  async remind(input: {
    readonly bookingIds: readonly string[];
    readonly queuedUntil: Date | null;
  }): Promise<{ sent: number; codes: string[] }> {
    if (input.bookingIds.length === 0) return { sent: 0, codes: [] };

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; code: string }[]>`
        UPDATE booking
           SET reminded_24h_at = now(), updated_at = now()
         WHERE id = ANY(${input.bookingIds.map((i) => i)}::uuid[])
           AND status IN ('confirmed', 'pending_payment', 'pending_confirmation')
        RETURNING id, code`;

      for (const r of rows) {
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: r.id,
            eventType: 'reminder.confirm_24h',
            payload: {
              code: r.code,
              manual: true,
              queuedUntil: input.queuedUntil?.toISOString() ?? null,
            },
          },
        });
      }

      return { sent: rows.length, codes: rows.map((r) => r.code) };
    });
  }

  /** Bookings that have not had the confirm-or-move message. */
  async notReminded(branchId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM booking
       WHERE branch_id = ${toUuid(branchId)}::uuid
         AND reminded_24h_at IS NULL
         AND status IN ('confirmed', 'pending_payment', 'pending_confirmation')
         AND start_at > now()
       ORDER BY start_at
       LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }
}

function actorUuid(input: {
  readonly actor: ActorKind;
  readonly actorId: string | null;
}): string | null {
  return input.actor === 'system' || input.actorId === null
    ? null
    : toUuid(input.actorId);
}
