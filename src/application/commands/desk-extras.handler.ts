import { Injectable, NotFoundException } from '@nestjs/common';
import { DeskExtrasRepository } from '@infrastructure/persistence/desk-extras.repository';
import { SeriesRepository } from '@infrastructure/persistence/series.repository';
import { PaymentWebhookHandler } from './payment-webhook.handler';
import {
  branchInstant,
  branchNowMinute,
  branchToday,
} from '@infrastructure/persistence/hold.repository';
import { whenToSend } from '@domain/booking/quiet-hours';
import { planDraws } from '@domain/booking/course';
import { Money } from '@domain/shared/money';
import { bookingError } from '@application/contract/errors';

/**
 * The last of the contract's desk actions.
 *
 * Reminders, the late-capture replay, and drawing a visit off a prepaid
 * course. Each one is thin on purpose: the rule it needs already exists in
 * the domain, and this only resolves the inputs and reports the answer.
 */
@Injectable()
export class DeskExtrasHandler {
  constructor(
    private readonly extras: DeskExtrasRepository,
    private readonly series: SeriesRepository,
    private readonly webhooks: PaymentWebhookHandler,
  ) {}

  /**
   * §7.1 Send the confirm-or-move reminder.
   *
   * QUIET HOURS QUEUE, they do not fail. A desk agent pressing this at 22:30
   * wants the customer reminded, just not woken; refusing would teach them
   * to retry in the morning, which is the same outcome with a person doing
   * the waiting.
   */
  async remind(bookingId: string): Promise<unknown> {
    const verdict = whenToSend(branchNowMinute());
    const queuedUntil =
      verdict.kind === 'send'
        ? null
        : branchInstant(
            addDays(branchToday(), verdict.dayOffset),
            verdict.untilMin,
          );

    const result = await this.extras.remind({
      bookingIds: [bookingId],
      queuedUntil,
    });
    if (result.sent === 0) {
      throw bookingError(
        'BOOKING_STATE_INVALID',
        'That booking is not in a state where a reminder means anything.',
      );
    }

    return {
      sent: verdict.kind === 'send',
      queued: verdict.kind === 'queued',
      channel: 'OUTBOX',
      queuedUntil: queuedUntil?.toISOString() ?? null,
      explanation:
        verdict.kind === 'send'
          ? 'Queued for delivery now.'
          : verdict.explanation,
      /**
       * HONEST ABOUT THE LAST MILE. The event is written and will be
       * relayed; nothing in this service actually sends a WhatsApp. A `sent:
       * true` that means "we wrote a row" would be a lie the desk acts on.
       */
      delivered: false,
      note: 'No message transport is wired yet; the event is queued in the outbox.',
    };
  }

  /** §7.1 The batch. Same rules, many bookings. */
  async remindBulk(branchId: string, limit: number): Promise<unknown> {
    const ids = await this.extras.notReminded(branchId, limit);
    const verdict = whenToSend(branchNowMinute());
    const queuedUntil =
      verdict.kind === 'send'
        ? null
        : branchInstant(
            addDays(branchToday(), verdict.dayOffset),
            verdict.untilMin,
          );

    const result = await this.extras.remind({ bookingIds: ids, queuedUntil });

    return {
      queued: result.sent,
      codes: result.codes,
      queuedUntil: queuedUntil?.toISOString() ?? null,
      explanation:
        verdict.kind === 'send'
          ? `${result.sent} queued for delivery now.`
          : `${result.sent} held: ${verdict.explanation}`,
      delivered: false,
    };
  }

  /**
   * §7.7 Replay the late-capture decision from the desk.
   *
   * THE SAME CODE PATH THE WEBHOOK USES. Money arriving after the window
   * closed either reinstates the booking or refunds it, and that decision
   * lives in `domain/booking/payment-webhook.ts`. Re-deciding it here would
   * be a second copy of the rule that matters most when it disagrees.
   */
  async lateCapture(input: {
    readonly bookingCode: string;
    readonly intentId: string;
    readonly amountFils: number;
    readonly rail: string;
  }): Promise<unknown> {
    return this.webhooks.execute({
      intent: {
        intentId: input.intentId,
        kind: 'captured',
        amountFils: input.amountFils,
        rail: input.rail,
      },
      bookingCode: input.bookingCode,
    });
  }

  /**
   * §10.4 Settle one visit against a prepaid course balance.
   *
   * The amount comes from the draw SCHEDULE, not from a division: the draws
   * have to sum back to exactly what was sold, or the course never closes at
   * zero and somebody has to shut it by hand.
   */
  async courseDraw(seriesId: string, bookingId: string): Promise<unknown> {
    const s = await this.series.load(seriesId);
    if (s === null) throw new NotFoundException('No such series');

    if (s.courseVisits === null || s.courseTotalNetFils === null) {
      throw bookingError(
        'BOOKING_STATE_INVALID',
        'This series was not sold as a prepaid course.',
      );
    }

    const schedule = planDraws({
      totalNetFils: s.courseTotalNetFils,
      visits: s.courseVisits,
    });
    const next = schedule[s.courseDrawn];
    if (next === undefined) {
      throw bookingError(
        'BOOKING_STATE_INVALID',
        `This course is exhausted: all ${s.courseVisits} visits have been drawn.`,
        { visits: s.courseVisits, drawn: s.courseDrawn },
      );
    }

    const drawn = await this.series.drawCourseVisit(
      seriesId,
      bookingId,
      next.grossFils,
    );

    return {
      seriesId,
      bookingId,
      visit: drawn,
      of: s.courseVisits,
      drawnMinor: next.grossFils,
      drawnDisplay: Money.fils(next.grossFils).toString(),
      netMinor: next.netFils,
      vatMinor: next.vatFils,
      remainingMinor: next.remainingAfterFils,
      remainingDisplay: Money.fils(next.remainingAfterFils).toString(),
      endsCourse: next.endsCourse,
      tender: 'Course credit applied',
    };
  }
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
