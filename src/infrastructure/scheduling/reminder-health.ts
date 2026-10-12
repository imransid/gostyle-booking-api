import { Injectable } from '@nestjs/common';
import { ReminderScheduler } from './reminder-scheduler.service';
import { ReminderDispatchJob } from './reminder-dispatch.service';
import {
  NotificationDeliveryRepository,
  type DeliveryQueueStats,
} from '../persistence/notification-delivery.repository';
import { REMINDER_DELIVERY } from '../messaging/reminder-delivery-listener';

export interface ReminderHealthView {
  /** REMINDER_DELIVERY: off means reminders are claimed but never sent. */
  readonly delivery: 'on' | 'off';
  readonly ladder: ReturnType<ReminderScheduler['stats']>;
  readonly dispatch: ReturnType<ReminderDispatchJob['stats']>;
  /**
   * The queue. `oldestDueSeconds` is the number to alert on: a due reminder
   * waiting minutes means nobody is dispatching, and the visit it is about
   * is getting closer.
   */
  readonly queue: DeliveryQueueStats | { readonly error: string };
}

/**
 * The reminder pipeline on one line of /health: the ladder that claims, the
 * queue between, the dispatcher that sends. ReminderScheduler.stats() said
 * "for /health" from the start and nothing called it; this does.
 */
@Injectable()
export class ReminderHealth {
  constructor(
    private readonly ladder: ReminderScheduler,
    private readonly dispatch: ReminderDispatchJob,
    private readonly deliveries: NotificationDeliveryRepository,
  ) {}

  async report(): Promise<ReminderHealthView> {
    let queue: ReminderHealthView['queue'];
    try {
      queue = await this.deliveries.stats();
    } catch (e) {
      queue = { error: e instanceof Error ? e.message : 'unknown' };
    }
    return {
      delivery: REMINDER_DELIVERY() ? 'on' : 'off',
      ladder: this.ladder.stats(),
      dispatch: this.dispatch.stats(),
      queue,
    };
  }
}
