import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, verifyHmacSha256Hex } from './hmac';
import {
  DEV_POS_CALLBACK_SECRET,
  posCallbackSecret,
} from './pos-callback-secret';

const BODY = '{"bookingId":"x","depositAppliedMinor":5000}';

describe('hmacSha256Hex', () => {
  it('is bare hex HMAC-SHA256 over the raw body, as the platform sends it', () => {
    expect(hmacSha256Hex('s3cret', BODY)).toBe(
      createHmac('sha256', 's3cret').update(BODY).digest('hex'),
    );
    expect(hmacSha256Hex('s3cret', BODY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyHmacSha256Hex', () => {
  const good = hmacSha256Hex('s3cret', BODY);

  it('accepts the signature of exactly these bytes', () => {
    expect(verifyHmacSha256Hex('s3cret', BODY, good)).toBe(true);
  });

  it('refuses another secret, another body, or a prefixed signature', () => {
    expect(verifyHmacSha256Hex('other', BODY, good)).toBe(false);
    expect(verifyHmacSha256Hex('s3cret', `${BODY} `, good)).toBe(false);
    expect(verifyHmacSha256Hex('s3cret', BODY, `sha256=${good}`)).toBe(false);
    expect(verifyHmacSha256Hex('s3cret', BODY, '')).toBe(false);
  });
});

describe('posCallbackSecret', () => {
  it('is the configured value, trimmed', () => {
    expect(posCallbackSecret({ POS_CALLBACK_SECRET: ' abc ' })).toBe('abc');
  });

  it('falls back to the dev secret outside production', () => {
    expect(posCallbackSecret({ NODE_ENV: 'development' })).toBe(
      DEV_POS_CALLBACK_SECRET,
    );
    expect(posCallbackSecret({})).toBe(DEV_POS_CALLBACK_SECRET);
  });

  it('fails closed in production without one, blank or unset', () => {
    expect(posCallbackSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(
      posCallbackSecret({ NODE_ENV: 'production', POS_CALLBACK_SECRET: '  ' }),
    ).toBeNull();
  });
});
