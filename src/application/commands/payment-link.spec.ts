import { describe, expect, it } from 'vitest';
import { paymentLinkBase, paymentLinkFor } from './payment-link.handler';

describe('the payment link URL', () => {
  it('is built from the configured base and the booking code', () => {
    expect(paymentLinkFor('GS-1233', 'https://pay.gostyle.uk')).toBe(
      'https://pay.gostyle.uk/pay/GS-1233',
    );
  });

  it('tolerates a base with a trailing slash', () => {
    expect(paymentLinkBase('https://pay.gostyle.uk/')).toBe(
      'https://pay.gostyle.uk',
    );
  });

  it('is null rather than a plausible dead page when nothing is configured', () => {
    // A URL invented here would be handed to a customer and would 404.
    expect(paymentLinkBase('')).toBeNull();
    expect(paymentLinkBase(undefined)).toBeNull();
    expect(paymentLinkFor('GS-1233', null)).toBeNull();
  });

  it('escapes the code rather than trusting it into a URL', () => {
    expect(paymentLinkFor('GS/1233', 'https://pay.gostyle.uk')).toBe(
      'https://pay.gostyle.uk/pay/GS%2F1233',
    );
  });
});
