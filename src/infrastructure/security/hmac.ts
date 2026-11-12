import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The one HMAC this service signs and verifies callbacks with: hex
 * HMAC-SHA256 over the RAW body, bare (no `sha256=` prefix), in
 * `x-signature`. The payment gateway's webhooks and the POS paid callback
 * both use it, so there is one implementation of "is this signed by who it
 * says" to get right.
 */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Compared in constant time. timingSafeEqual rather than ===: a string
 * comparison returns as soon as two bytes differ, and the time it took is a
 * measurable signal about how much of the signature was right.
 */
export function verifyHmacSha256Hex(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const a = Buffer.from(hmacSha256Hex(secret, rawBody));
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // one bit, but an unavoidable and harmless one.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
