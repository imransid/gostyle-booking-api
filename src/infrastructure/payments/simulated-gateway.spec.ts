import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  DEV_WEBHOOK_SECRET,
  SimulatedGateway,
  webhookSecret,
} from './simulated-gateway';

const BODY =
  '{"intentId":"sim_1","bookingCode":"GS-1","kind":"CAPTURED","amountMinor":100,"rail":"card"}';
const signed = (secret: string) =>
  createHmac('sha256', secret).update(BODY).digest('hex');

const saved = {
  secret: process.env.PAYMENT_WEBHOOK_SECRET,
  env: process.env.NODE_ENV,
};
afterEach(() => {
  if (saved.secret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
  else process.env.PAYMENT_WEBHOOK_SECRET = saved.secret;
  if (saved.env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.env;
  vi.restoreAllMocks();
});

describe('webhookSecret', () => {
  it('the configured one, wherever it runs', () => {
    expect(
      webhookSecret({ PAYMENT_WEBHOOK_SECRET: 's3', NODE_ENV: 'production' }),
    ).toBe('s3');
  });

  it('production without one: none, so every webhook is refused', () => {
    expect(webhookSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(
      webhookSecret({ NODE_ENV: 'production', PAYMENT_WEBHOOK_SECRET: '  ' }),
    ).toBeNull();
  });

  it('a local run or a test keeps the development one', () => {
    expect(webhookSecret({})).toBe(DEV_WEBHOOK_SECRET);
    expect(webhookSecret({ NODE_ENV: 'test' })).toBe(DEV_WEBHOOK_SECRET);
  });
});

describe('SimulatedGateway.verifySignature', () => {
  it('production without a secret refuses even the old known signature', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_WEBHOOK_SECRET;
    const gateway = new SimulatedGateway();
    expect(gateway.verifySignature(BODY, signed(DEV_WEBHOOK_SECRET))).toBe(
      false,
    );
    expect(() => gateway.sign(BODY)).toThrow(
      'PAYMENT_WEBHOOK_SECRET is not set',
    );
  });

  it('production with a secret takes only its own signature', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_WEBHOOK_SECRET = 'real-secret';
    const gateway = new SimulatedGateway();
    expect(gateway.verifySignature(BODY, signed('real-secret'))).toBe(true);
    expect(gateway.verifySignature(BODY, signed(DEV_WEBHOOK_SECRET))).toBe(
      false,
    );
    expect(gateway.sign(BODY)).toBe(signed('real-secret'));
  });

  it('a local run signs and verifies with the development secret', () => {
    delete process.env.NODE_ENV;
    delete process.env.PAYMENT_WEBHOOK_SECRET;
    const gateway = new SimulatedGateway();
    expect(gateway.verifySignature(BODY, gateway.sign(BODY))).toBe(true);
  });

  it('says so at boot when production has no secret', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_WEBHOOK_SECRET;
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    new SimulatedGateway().onModuleInit();
    expect(error).toHaveBeenCalledOnce();
  });
});
