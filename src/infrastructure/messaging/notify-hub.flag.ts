/**
 * Booking events through customer-api's Notification Center, on or off.
 *
 * OFF BY DEFAULT. `MOBILE_NOTIFY_HUB=true`: "Booking confirmed / moved /
 * cancelled" go to customer-api (gRPC CustomerNotifications.Notify), which
 * keeps them in the customer's Notification Center and sends the push and
 * email by their switches; PushListener stays quiet for them, and the
 * mobile payment PATCH writes booking.payment_recorded. Off: none of that,
 * and PushListener pushes as before. Read on every event, like the other
 * flags.
 *
 * Turn it on only after customer-api serves Notify (its PR
 * feat/notify-grpc), or every hand-over retries and then fails.
 */
export const MOBILE_NOTIFY_HUB = (): boolean =>
  (process.env.MOBILE_NOTIFY_HUB ?? '').trim().toLowerCase() === 'true';
