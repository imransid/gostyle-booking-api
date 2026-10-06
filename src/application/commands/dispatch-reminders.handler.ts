import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  greetingName,
  pushEventId,
  readiness,
  rungOfEvent,
  settle,
  type ChannelOutcome,
  type Settlement,
} from '@domain/booking/reminder-delivery';
import { paymentPending, type Rung } from '@domain/booking/reminders';
import {
  emailCopy,
  pushCopy,
  type ReminderFacts,
} from '@domain/booking/reminder-message';
import {
  CUSTOMER_CONTACT,
  type ContactLookup,
  type CustomerContactReader,
} from '@application/ports/customer-contact.port';
import {
  PUSH_SENDER,
  type PushSender,
} from '@application/ports/push-sender.port';
import {
  EMAIL_SENDER,
  type EmailSender,
} from '@application/ports/email-sender.port';
import {
  NotificationDeliveryRepository,
  type ClaimedDelivery,
  type DeliveryBooking,
} from '@infrastructure/persistence/notification-delivery.repository';
import { branchUtcOffsetMin } from '@infrastructure/persistence/hold.repository';
import { renderReminderEmail } from '@infrastructure/messaging/reminder-email.layout';

/**
 * Rows per claim. Small, because each row may wait on customer-api, push-app
 * and an SMTP server in turn, and the whole batch must finish well inside
 * the lease (DISPATCH_LEASE_MS) or a second worker would take the same rows.
 */
export const DISPATCH_BATCH = 10;

export interface DispatchReport {
  readonly claimed: number;
  readonly sent: number;
  /** Failed this attempt, due again later. */
  readonly retrying: number;
  readonly failed: number;
  readonly skipped: number;
  readonly superseded: number;
  /** Could not record: the lease ran out and another worker has the row. */
  readonly lost: number;
}

type RowResult = Settlement['status'] | 'superseded' | 'lost';

type Lookup = (customerId: string) => Promise<ContactLookup>;

/**
 * Sends the reminders that are due, one channel per row.
 *
 *   claim -> is the visit still on, at that time?  -> who is it, and do they
 *   want it? -> send on THIS row's channel -> record what happened
 *
 * CHANNELS NEVER WAIT ON EACH OTHER. Push and email for one reminder are two
 * rows, claimed, sent and settled apart: a push-app outage leaves the email
 * row untouched, an SMTP failure retries only the email, and neither can
 * make the other go twice.
 *
 * NOTHING HERE HOLDS A TRANSACTION. The claim commits before anything is
 * sent and the result is a separate write, so a slow dependency only ever
 * delays its own rows.
 */
@Injectable()
export class DispatchRemindersHandler {
  private static readonly log = new Logger(DispatchRemindersHandler.name);

  constructor(
    private readonly deliveries: NotificationDeliveryRepository,
    @Inject(CUSTOMER_CONTACT) private readonly contacts: CustomerContactReader,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async run(
    nowMs: number = Date.now(),
    limit: number = DISPATCH_BATCH,
  ): Promise<DispatchReport> {
    const claimed = await this.deliveries.claimDue(nowMs, limit);
    if (claimed.length === 0) return tally([], 0);

    const bookings = await this.deliveries.bookings([
      ...new Set(claimed.map((d) => d.bookingId)),
    ]);

    // One lookup per customer per batch: a reminder's push and email rows
    // usually arrive together and ask the same question.
    const asked = new Map<string, Promise<ContactLookup>>();
    const lookup: Lookup = (customerId) => {
      let answer = asked.get(customerId);
      if (answer === undefined) {
        answer = this.contacts
          .lookup(customerId)
          .catch((e: unknown): ContactLookup => ({
            kind: 'unavailable',
            error: e instanceof Error ? e.message : String(e),
          }));
        asked.set(customerId, answer);
      }
      return answer;
    };

    const results = await Promise.all(
      claimed.map((d) =>
        this.dispatchOne(d, bookings.get(d.bookingId) ?? null, lookup, nowMs),
      ),
    );

    const report = tally(results, claimed.length);
    if (report.failed > 0 || report.retrying > 0 || report.lost > 0) {
      DispatchRemindersHandler.log.warn(describe(report));
    } else {
      DispatchRemindersHandler.log.log(describe(report));
    }
    return report;
  }

  private async dispatchOne(
    d: ClaimedDelivery,
    booking: DeliveryBooking | null,
    lookup: Lookup,
    nowMs: number,
  ): Promise<RowResult> {
    try {
      const ready = readiness({
        booking:
          booking === null
            ? null
            : { status: booking.status, startAtMs: booking.startAtMs },
        scheduledForMs: d.scheduledForMs,
        expiresAtMs: d.expiresAtMs,
        attempt: d.attempt,
        nowMs,
      });
      if (ready.kind === 'supersede') {
        return this.write(d, { status: 'superseded' }, nowMs);
      }
      if (ready.kind === 'skip') {
        return this.write(
          d,
          { status: 'skipped', reason: ready.reason },
          nowMs,
        );
      }
      if (ready.kind === 'fail') {
        return this.write(d, { status: 'failed', error: ready.error }, nowMs);
      }

      const rung = rungOfEvent(d.eventType);
      if (rung === null || booking === null) {
        return this.write(
          d,
          { status: 'skipped', reason: 'not_a_reminder' },
          nowMs,
        );
      }

      const outcome =
        d.channel === 'push'
          ? await this.sendPush(d, booking, rung, lookup, nowMs)
          : await this.sendEmail(d, booking, rung, lookup, nowMs);

      const settlement = settle({
        outcome,
        attempt: d.attempt,
        nowMs,
        expiresAtMs: d.expiresAtMs,
      });
      if (settlement.status === 'failed') {
        DispatchRemindersHandler.log.error(
          `${d.eventType} ${d.channel} for booking ${booking.code} failed ` +
            `on attempt ${d.attempt}: ${settlement.error}`,
        );
      }
      return this.write(d, settlement, nowMs);
    } catch (e) {
      // A bug, or the database gone mid-row. Nothing is recorded; the lease
      // brings the row back, and the attempt it burned still counts.
      DispatchRemindersHandler.log.error(
        `${d.eventType} ${d.channel} delivery ${d.id}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return 'lost';
    }
  }

  /**
   * Push needs no address, only a customer id, so it goes even when
   * customer-api cannot be asked: preferences that cannot be read are taken
   * at their defaults (on), and push-app decides by the devices it holds. A
   * reminder held hostage to a second service would usually arrive after
   * the visit. What customer-api CAN say -- reminders off, push off -- wins.
   */
  private async sendPush(
    d: ClaimedDelivery,
    booking: DeliveryBooking,
    rung: Rung,
    lookup: Lookup,
    nowMs: number,
  ): Promise<ChannelOutcome> {
    if (!this.push.configured()) {
      return { kind: 'skipped', reason: 'push_not_configured' };
    }
    const who = await lookup(d.customerId);
    if (who.kind === 'unavailable') {
      DispatchRemindersHandler.log.warn(
        `push ${booking.code}: preferences unreadable (${who.error}); sending at defaults`,
      );
    }
    if (
      who.kind === 'found' &&
      (!who.contact.appointmentReminder || !who.contact.pushEnabled)
    ) {
      return { kind: 'skipped', reason: 'opted_out' };
    }

    const copy = pushCopy(
      this.facts(
        booking,
        rung,
        who.kind === 'found' ? who.contact.fullName : null,
        nowMs,
      ),
    );
    return this.push.send({
      userId: d.customerId,
      eventId: pushEventId(d.bookingId, rung, d.scheduledForMs),
      title: copy.title,
      body: copy.body,
      data: {
        type: d.eventType,
        bookingId: d.bookingId,
        code: booking.code,
        startAt: new Date(booking.startAtMs).toISOString(),
      },
    });
  }

  /**
   * Email needs the address, so it does wait for customer-api: no answer is
   * a retry, never a guess. Only a verified address is written to -- an
   * unverified one may be a typo, and a typo is a stranger's inbox holding
   * someone's appointment.
   */
  private async sendEmail(
    d: ClaimedDelivery,
    booking: DeliveryBooking,
    rung: Rung,
    lookup: Lookup,
    nowMs: number,
  ): Promise<ChannelOutcome> {
    if (!this.email.configured()) {
      return { kind: 'skipped', reason: 'email_not_configured' };
    }
    const who = await lookup(d.customerId);
    if (who.kind === 'unavailable') return { kind: 'retry', error: who.error };
    if (who.kind === 'not_found') {
      return { kind: 'skipped', reason: 'customer_not_found' };
    }

    const { contact } = who;
    if (!contact.appointmentReminder)
      return { kind: 'skipped', reason: 'opted_out' };
    if (contact.email === null) return { kind: 'skipped', reason: 'no_email' };
    if (!contact.emailVerified)
      return { kind: 'skipped', reason: 'email_unverified' };

    const copy = emailCopy(this.facts(booking, rung, contact.fullName, nowMs));
    const { html, text } = renderReminderEmail(
      copy,
      new Date(nowMs).getUTCFullYear(),
    );
    return this.email.send({
      to: contact.email,
      subject: copy.subject,
      text,
      html,
    });
  }

  private facts(
    booking: DeliveryBooking,
    rung: Rung,
    fullName: string | null,
    nowMs: number,
  ): ReminderFacts {
    return {
      rung,
      startAtMs: booking.startAtMs,
      nowMs,
      offsetMin: branchUtcOffsetMin(),
      code: booking.code,
      services: booking.services,
      durationMin: booking.durationMin,
      paymentPending: paymentPending(booking.paymentStatus),
      firstName: greetingName(fullName),
    };
  }

  private async write(
    d: ClaimedDelivery,
    outcome: Settlement | { readonly status: 'superseded' },
    nowMs: number,
  ): Promise<RowResult> {
    const recorded = await this.deliveries.record(d, outcome, nowMs);
    if (!recorded) {
      DispatchRemindersHandler.log.warn(
        `delivery ${d.id} attempt ${d.attempt}: another worker holds it now; ` +
          'this result was not recorded',
      );
      return 'lost';
    }
    return outcome.status;
  }
}

function tally(results: readonly RowResult[], claimed: number): DispatchReport {
  const count = (s: RowResult) => results.filter((r) => r === s).length;
  return {
    claimed,
    sent: count('sent'),
    retrying: count('pending'),
    failed: count('failed'),
    skipped: count('skipped'),
    superseded: count('superseded'),
    lost: count('lost'),
  };
}

function describe(r: DispatchReport): string {
  return (
    `dispatched ${r.claimed}: ${r.sent} sent, ${r.retrying} retrying, ` +
    `${r.failed} failed, ${r.skipped} skipped, ${r.superseded} superseded` +
    (r.lost > 0 ? `, ${r.lost} lost to another worker` : '')
  );
}
