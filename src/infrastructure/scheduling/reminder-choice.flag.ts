import { MOBILE_NOTIFY_HUB } from '../messaging/notify-hub.flag';

/**
 * The app customer's own reminder time, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_REMINDER_CHOICE=true`: an app booking (channel
 * `online`) gets ONE automatic reminder, at the time its customer chose in
 * the app (customer-api GetReminderLeads), handed to customer-api's
 * Notification Center; the three fixed rungs stop claiming app bookings.
 * Desk bookings keep the fixed ladder either way. Off: the ladder exactly as
 * before. Read on every tick, like the other flags.
 *
 * Needs MOBILE_NOTIFY_HUB on too: the chosen reminder is sent only through
 * the Notification Center. With the hub off this flag does nothing, and the
 * fixed rungs carry on for every booking.
 */
export const MOBILE_REMINDER_CHOICE = (): boolean =>
  (process.env.MOBILE_REMINDER_CHOICE ?? '').trim().toLowerCase() === 'true';

/** The chosen reminder really runs: its flag, and the hub it is sent by. */
export const chosenRemindersOn = (): boolean =>
  MOBILE_REMINDER_CHOICE() && MOBILE_NOTIFY_HUB();
