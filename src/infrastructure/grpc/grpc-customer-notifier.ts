import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callOnce, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure, grpcStatusOf } from './grpc-failure';
import type { ChannelOutcome } from '@domain/booking/reminder-delivery';
import type {
  CustomerNotifier,
  NotifyRequest,
} from '@application/ports/customer-notifier.port';
import type {
  ReminderLeadReader,
  ReminderLeadsAnswer,
} from '@application/ports/reminder-leads.port';
import type { ReminderChoice } from '@domain/booking/chosen-reminder';

/** Injection token for the raw client; CUSTOMER_NOTIFIER names the port. */
export const CUSTOMER_NOTIFICATIONS_CLIENT = 'CUSTOMER_NOTIFICATIONS_CLIENT';

/** The wire shape, snake_case, as customer_notifications.proto declares it. */
interface NotifyRequestWire {
  consumer_id: string;
  type: string;
  dedupe_key: string;
  params: Record<string, string>;
  target_type: string;
  target_id: string;
  source: string;
  deliver_by: string;
}

interface NotifyReplyWire {
  /** enums: String in the loader, so the enum's name. */
  outcome?: string;
  notification_id?: string;
}

interface ReminderLeadsReplyWire {
  leads?: Record<string, { enabled?: boolean; lead_minutes?: number }>;
}

interface CustomerNotificationsGrpc {
  notify(
    data: NotifyRequestWire,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<NotifyReplyWire>;
  getReminderLeads(
    data: { consumer_ids: string[] },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<ReminderLeadsReplyWire>;
}

/** customer-api answers at most this many ids per call. */
export const LEADS_PER_CALL = 1000;

/**
 * One attempt per claim, as the reminder push makes: the dispatcher retries
 * with backoff, so a second in-line try would only hold its batch. Keeping
 * an item is a few writes; anything slower is customer-api in trouble.
 */
const CALL_TIMEOUT_MS = 3_000;

/** This service misconfigured, or customer-api not yet deployed with it. */
const MISCONFIGURED: ReadonlySet<number> = new Set<number>([
  status.UNAUTHENTICATED,
  status.PERMISSION_DENIED,
  status.UNIMPLEMENTED,
]);

/**
 * CUSTOMER_NOTIFIER and REMINDER_LEADS over gRPC to customer-api's
 * CustomerNotifications, the same server and key as ConsumerDirectory.
 */
@Injectable()
export class GrpcCustomerNotifier
  implements CustomerNotifier, ReminderLeadReader, OnModuleInit
{
  private readonly logger = new Logger(GrpcCustomerNotifier.name);
  private svc!: CustomerNotificationsGrpc;

  constructor(
    @Inject(CUSTOMER_NOTIFICATIONS_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc = this.client.getService<CustomerNotificationsGrpc>(
      'CustomerNotifications',
    );
  }

  async notify(request: NotifyRequest): Promise<ChannelOutcome> {
    // Read per call, like the contact lookup: a key rotation needs a
    // restart, not a rebuild.
    const key = (process.env.INTERNAL_GRPC_KEY ?? '').trim();
    const wire: NotifyRequestWire = {
      consumer_id: request.consumerId,
      type: request.type,
      dedupe_key: request.dedupeKey,
      params: { ...request.params },
      target_type: request.targetType,
      target_id: request.targetId,
      source: 'booking-api',
      deliver_by: request.deliverBy,
    };
    try {
      const reply = await callOnce(CALL_TIMEOUT_MS, (md, opts) => {
        if (key !== '') md.set('x-internal-key', key);
        return this.svc.notify(wire, md, opts);
      });
      return outcomeOf(reply);
    } catch (e) {
      const code = grpcStatusOf(e);
      const error = `customer-api ${describeGrpcFailure(e)}`;
      if (code === status.INVALID_ARGUMENT) {
        return { kind: 'failed', error };
      }
      if (code !== null && MISCONFIGURED.has(code)) {
        this.logger.error(
          `${error} -- check INTERNAL_GRPC_KEY on both sides and that ` +
            'customer-api serves CustomerNotifications',
        );
      }
      return { kind: 'retry', error };
    }
  }

  /**
   * One call per LEADS_PER_CALL customers; any call without an answer makes
   * the whole answer unavailable, so a tick never acts on half a picture.
   */
  async leads(customerIds: readonly string[]): Promise<ReminderLeadsAnswer> {
    const key = (process.env.INTERNAL_GRPC_KEY ?? '').trim();
    const unique = [...new Set(customerIds)];
    const leads = new Map<string, ReminderChoice>();
    try {
      for (let i = 0; i < unique.length; i += LEADS_PER_CALL) {
        const batch = unique.slice(i, i + LEADS_PER_CALL);
        const reply = await callOnce(CALL_TIMEOUT_MS, (md, opts) => {
          if (key !== '') md.set('x-internal-key', key);
          return this.svc.getReminderLeads({ consumer_ids: batch }, md, opts);
        });
        for (const [id, lead] of Object.entries(reply.leads ?? {})) {
          leads.set(id, {
            // proto3 leaves false and 0 off the wire; a missing lead is not a
            // choice, and chosenVerdict waits on it.
            enabled: lead.enabled === true,
            leadMinutes: lead.lead_minutes ?? 0,
          });
        }
      }
      return { kind: 'answered', leads };
    } catch (e) {
      const code = grpcStatusOf(e);
      const error = `customer-api ${describeGrpcFailure(e)}`;
      if (code !== null && MISCONFIGURED.has(code)) {
        this.logger.error(
          `${error} -- check INTERNAL_GRPC_KEY on both sides and that ` +
            'customer-api serves GetReminderLeads',
        );
      }
      return { kind: 'unavailable', error };
    }
  }
}

/** What customer-api answered, in the retry rule's words. */
export function outcomeOf(reply: NotifyReplyWire): ChannelOutcome {
  const id = reply.notification_id ?? '';
  switch (reply.outcome) {
    case 'ACCEPTED':
      return { kind: 'sent', ref: `accepted:${id}` };
    case 'DUPLICATE':
      return { kind: 'sent', ref: `duplicate:${id}` };
    case 'SUPPRESSED':
      return { kind: 'sent', ref: 'suppressed' };
    case 'NOT_FOUND':
      return { kind: 'skipped', reason: 'customer_not_found' };
    default:
      // OUTCOME_UNSPECIFIED, or one this build does not know: a newer
      // customer-api. Asking again later costs little; guessing could lose
      // the notification.
      return {
        kind: 'retry',
        error: `customer-api answered outcome ${String(reply.outcome)}`,
      };
  }
}
