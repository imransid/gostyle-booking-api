/**
 * When a message may actually go out.
 *
 * A reminder is a phone buzzing on someone's bedside table. The branch's
 * quiet hours say the salon does not do that between 21:00 and 09:00, and
 * the rule the contract asks for is deliberately NOT "refuse": a desk agent
 * pressing "remind" at 22:30 wants the customer reminded, just not woken.
 * So a send inside quiet hours is QUEUED for the next opening minute and the
 * response says when it will leave.
 *
 * Failing instead would teach the desk to retry in the morning, which is the
 * same outcome with a human doing the waiting.
 */

/** First minute a message may go out. 09:00. */
export const QUIET_END_MIN = 9 * 60;

/** First minute it may not. 21:00. */
export const QUIET_START_MIN = 21 * 60;

export type SendVerdict =
  | { readonly kind: 'send' }
  | {
      readonly kind: 'queued';
      /** Minutes past midnight, on the next day when it wraps. */
      readonly untilMin: number;
      /** 0 for later today, 1 for tomorrow morning. */
      readonly dayOffset: number;
      readonly explanation: string;
    };

/**
 * The window is [09:00, 21:00). 21:00 exactly is already quiet; 09:00
 * exactly is already open.
 */
export function withinQuietHours(minuteOfDay: number): boolean {
  return minuteOfDay < QUIET_END_MIN || minuteOfDay >= QUIET_START_MIN;
}

export function whenToSend(minuteOfDay: number): SendVerdict {
  if (!withinQuietHours(minuteOfDay)) return { kind: 'send' };

  // Before 09:00 is later the SAME day; from 21:00 it is tomorrow morning.
  const dayOffset = minuteOfDay < QUIET_END_MIN ? 0 : 1;

  return {
    kind: 'queued',
    untilMin: QUIET_END_MIN,
    dayOffset,
    explanation:
      dayOffset === 0
        ? 'Inside quiet hours. It will go out at 09:00 this morning.'
        : 'Inside quiet hours. It will go out at 09:00 tomorrow.',
  };
}
