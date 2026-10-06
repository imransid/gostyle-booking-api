import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import {
  SmtpEmailClient,
  classifySmtpError,
  smtpConfig,
  type SmtpConfig,
} from './smtp-email.client';
import { escapeHtml, renderReminderEmail } from './reminder-email.layout';
import { emailCopy } from '@domain/booking/reminder-message';

const MESSAGE = {
  to: 'sara@example.com',
  subject: 'Reminder: Your GoStyle appointment is tomorrow',
  text: 'Hi Sara,',
  html: '<p>Hi Sara,</p>',
};

class FakeTransportClient extends SmtpEmailClient {
  readonly sendMail = vi.fn();
  readonly made: SmtpConfig[] = [];
  protected override createTransport(config: SmtpConfig): Transporter {
    this.made.push(config);
    return { sendMail: this.sendMail } as unknown as Transporter;
  }
}

const KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_FROM_NAME',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'no-reply@gostyle.example';
  process.env.SMTP_PASS = 'secret';
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_FROM_NAME;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('configuration, under the platform EmailService names', () => {
  it('reads SMTP_* and sends from SMTP_USER as GoStyle by default', () => {
    expect(smtpConfig()).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'no-reply@gostyle.example',
      pass: 'secret',
      fromName: 'GoStyle',
      fromAddress: 'no-reply@gostyle.example',
    });
  });

  it('no SMTP_HOST: email is not configured, and is skipped rather than failed', async () => {
    delete process.env.SMTP_HOST;
    const client = new FakeTransportClient();
    expect(await client.send(MESSAGE)).toEqual({
      kind: 'skipped',
      reason: 'email_not_configured',
    });
    expect(client.sendMail).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('a message the server accepted is sent, with its message id', async () => {
    const client = new FakeTransportClient();
    client.sendMail.mockResolvedValue({ messageId: '<abc@gostyle>' });
    expect(await client.send(MESSAGE)).toEqual({
      kind: 'sent',
      ref: '<abc@gostyle>',
    });
    expect(client.sendMail).toHaveBeenCalledWith({
      from: { name: 'GoStyle', address: 'no-reply@gostyle.example' },
      ...MESSAGE,
    });
  });

  it('never throws: a failure comes back classified', async () => {
    const client = new FakeTransportClient();
    client.sendMail.mockRejectedValue(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );
    await expect(client.send(MESSAGE)).resolves.toEqual({
      kind: 'retry',
      error: 'SMTP ETIMEDOUT: timeout',
    });
  });

  it('reuses one transport while the settings stay the same', async () => {
    const client = new FakeTransportClient();
    client.sendMail.mockResolvedValue({ messageId: 'x' });
    await client.send(MESSAGE);
    await client.send(MESSAGE);
    expect(client.made).toHaveLength(1);
  });
});

describe('classifySmtpError: will trying again help?', () => {
  it.each([
    [{ responseCode: 451, response: '451 greylisted' }, 'retry'],
    [{ responseCode: 421, response: '421 too many connections' }, 'retry'],
    [{ responseCode: 550, response: '550 no such user' }, 'failed'],
    [{ code: 'EAUTH', message: 'Invalid login' }, 'failed'],
    [{ code: 'EENVELOPE', message: 'No recipients defined' }, 'failed'],
    [{ code: 'ECONNECTION', message: 'connect ECONNREFUSED' }, 'retry'],
    [{ code: 'ESOCKET', message: 'socket hang up' }, 'retry'],
    [new Error('something unforeseen'), 'retry'],
  ])('%j -> %s', (error, kind) => {
    expect(classifySmtpError(error).kind).toBe(kind);
  });
});

describe('the reminder email', () => {
  const copy = emailCopy({
    rung: 'confirm_24h',
    startAtMs: Date.parse('2026-10-11T04:00:00Z'),
    nowMs: Date.parse('2026-10-10T04:00:00Z'),
    offsetMin: 360,
    code: 'GS-1050',
    services: ['Full colour'],
    durationMin: 105,
    paymentPending: false,
    firstName: 'Sara',
  });

  it('carries the greeting, the date, the time, the services and the code', () => {
    const { html, text } = renderReminderEmail(copy, 2026);
    for (const s of [
      'Hi Sara,',
      'Sunday, 11 October 2026',
      '10:00 AM',
      'Full colour',
      'GS-1050',
    ]) {
      expect(html).toContain(s);
      expect(text).toContain(s);
    }
    expect(text).toContain('Booking code: GS-1050');
  });

  it('escapes what people typed', () => {
    const hostile = emailCopy({
      rung: 'confirm_24h',
      startAtMs: Date.parse('2026-10-11T04:00:00Z'),
      nowMs: Date.parse('2026-10-10T04:00:00Z'),
      offsetMin: 360,
      code: 'GS-1050',
      services: ['<script>alert(1)</script>'],
      durationMin: 0,
      paymentPending: false,
      firstName: 'Sara"><img',
    });
    const { html } = renderReminderEmail(hostile, 2026);
    expect(html).not.toContain('<script>');
    expect(html).toContain(escapeHtml('<script>alert(1)</script>'));
    expect(html).not.toContain('Sara"><img');
  });
});
