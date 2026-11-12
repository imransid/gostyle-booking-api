/**
 * The secret for local runs and tests. NEVER used where NODE_ENV is
 * production: it is in this repository, so anyone could sign a "ticket paid"
 * with it -- and a forged one settles a booking and credits a wallet.
 */
export const DEV_POS_CALLBACK_SECRET = 'dev-pos-callback-secret';

/**
 * The secret the platform signs its POS paid callback with
 * (POST /v1/internal/pos/ticket-paid): POS_CALLBACK_SECRET here, the same
 * value as the platform's BOOKING_API_CALLBACK_SECRET. Outside production
 * only, DEV_POS_CALLBACK_SECRET when unset.
 *
 * Null in production without one, and then every callback is refused: FAIL
 * CLOSED, never open, exactly as webhookSecret() does for payments. Blank
 * counts as unset: an HMAC with an empty key is no secret.
 */
export function posCallbackSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = (env.POS_CALLBACK_SECRET ?? '').trim();
  if (configured !== '') return configured;
  return env.NODE_ENV === 'production' ? null : DEV_POS_CALLBACK_SECRET;
}
