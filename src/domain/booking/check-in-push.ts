/**
 * A push when the desk answers a self check-in request (CHECK_IN_PUSH_V1).
 *
 * Pure: which answers are told, what the phone reads, and the id that keeps
 * push-app from buzzing twice. Who is asked, and when, is the listener's
 * (infrastructure/messaging/check-in-push-listener.ts).
 *
 * THREE ANSWERS ARE TOLD, the three the customer is waiting for:
 *
 *   approved   the desk said yes: they are checked in
 *   rejected   the desk said no: speak to the desk
 *   expired    nobody answered before the booking ended: speak to the desk
 *
 * Not `closed` (the desk checked them in with its own button, or the booking
 * was cancelled or moved: each of those is its own news) and not `withdrawn`
 * (the customer did it themselves, in the app).
 */
export type CheckInAnswer = 'approved' | 'rejected' | 'expired';

/** The outbox event each answer is written as, in the answer's transaction. */
export const CHECK_IN_ANSWER_EVENTS: Readonly<Record<CheckInAnswer, string>> = {
  approved: 'check_in_request.approved',
  rejected: 'check_in_request.rejected',
  expired: 'check_in_request.expired',
};

/** The answer an outbox event carries, or null for any other event. */
export function answerOfEvent(eventType: string): CheckInAnswer | null {
  for (const [answer, type] of Object.entries(CHECK_IN_ANSWER_EVENTS)) {
    if (type === eventType) return answer as CheckInAnswer;
  }
  return null;
}

/**
 * push-app sends at most once per (user, eventId, device). A request is
 * answered once, so its id and the answer are enough: a re-delivered event
 * can never buzz the phone again.
 */
export function checkInPushEventId(
  requestId: string,
  answer: CheckInAnswer,
): string {
  return `check-in:${requestId}:${answer}`;
}

/**
 * Whose check-in the push is about, seen from the person it goes to (the one
 * who tapped). `self`: their own. `member`: someone else in their party,
 * asked for by the booker's We are here; `name` is null when nobody has one.
 */
export type CheckInPushSubject =
  | { readonly kind: 'self' }
  | { readonly kind: 'member'; readonly name: string | null };

export interface CheckInPushCopy {
  readonly title: string;
  readonly body: string;
}

const SPEAK_TO_THE_DESK = 'Please speak to the desk';

/**
 * What the phone reads. Short and plain, with the booking code, as the
 * reminders write it (reminder-message.ts). The desk's own reason for a
 * rejection is never sent: it stays with the desk.
 */
export function checkInPushCopy(f: {
  readonly answer: CheckInAnswer;
  readonly code: string;
  readonly subject: CheckInPushSubject;
}): CheckInPushCopy {
  const booking = `Booking ${f.code}.`;
  const name = f.subject.kind === 'member' ? cleanName(f.subject.name) : null;

  if (f.subject.kind === 'self') {
    switch (f.answer) {
      case 'approved':
        return { title: 'You are checked in', body: `Welcome! ${booking}` };
      case 'rejected':
        return {
          title: SPEAK_TO_THE_DESK,
          body: `The salon could not confirm your arrival. ${booking}`,
        };
      case 'expired':
        return {
          title: SPEAK_TO_THE_DESK,
          body: `The salon did not answer your check-in in time. ${booking}`,
        };
    }
  }

  switch (f.answer) {
    case 'approved':
      return {
        title: `${name ?? 'A member of your party'} is checked in`,
        body: booking,
      };
    case 'rejected':
      return {
        title: SPEAK_TO_THE_DESK,
        body:
          name === null
            ? `The salon could not confirm the arrival of a member of your party. ${booking}`
            : `The salon could not confirm ${name}'s arrival. ${booking}`,
      };
    case 'expired':
      return {
        title: SPEAK_TO_THE_DESK,
        body:
          name === null
            ? `The salon did not answer a party member's check-in in time. ${booking}`
            : `The salon did not answer ${name}'s check-in in time. ${booking}`,
      };
  }
}

/** A name as held, trimmed; blank is no name. */
function cleanName(name: string | null): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
