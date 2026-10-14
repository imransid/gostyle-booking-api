/**
 * The check-in push, on or off.
 *
 * OFF BY DEFAULT. `CHECK_IN_PUSH_V1=true` turns it on; anything else, a typo
 * included, is off. Off, no check-in answer is written to the outbox and no
 * push is sent: the desk's approve and reject, and the lapse job, behave
 * exactly as before. Read on every call, like the other flags, so a restart
 * is all a deploy needs.
 */
export const CHECK_IN_PUSH_V1 = (): boolean =>
  (process.env.CHECK_IN_PUSH_V1 ?? '').trim().toLowerCase() === 'true';
