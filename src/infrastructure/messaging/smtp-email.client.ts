import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { ChannelOutcome } from '@domain/booking/reminder-delivery';
import { BRAND } from '@domain/booking/reminder-message';
import type {
  EmailMessage,
  EmailSender,
} from '@application/ports/email-sender.port';

/**
 * The SMTP settings, from the SAME variable names gostyle-platform's
 * EmailService reads, so one relay account can serve both and an operator
 * has one vocabulary to learn.
 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly fromName: string;
  readonly fromAddress: string;
}

/**
 * Null when email is not set up: no SMTP_HOST, or nothing to send from.
 * Read per send, not at boot, so .env (loaded by ConfigModule after this
 * module) is honoured on a laptop and a restart is all a change needs.
 */
export function smtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null {
  const host = (env.SMTP_HOST ?? '').trim();
  const user = (env.SMTP_USER ?? '').trim();
  const fromAddress = (env.MAIL_FROM ?? '').trim() || user;
  if (host === '' || fromAddress === '') return null;
  const port = Number(env.SMTP_PORT ?? '');
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: (env.SMTP_SECURE ?? '').trim().toLowerCase() === 'true',
    user,
    pass: env.SMTP_PASS ?? '',
    fromName: (env.MAIL_FROM_NAME ?? '').trim() || BRAND,
    fromAddress,
  };
}

/** nodemailer's error, as far as classifying it needs. */
interface SmtpError {
  readonly code?: unknown;
  readonly responseCode?: unknown;
  readonly response?: unknown;
  readonly message?: unknown;
}

/** Codes that mean the conversation never properly happened. */
const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETLS',
]);

/**
 * What an SMTP failure means for trying again.
 *
 * The server's reply code decides when there is one: 4xx is SMTP's own word
 * for "not now" (greylisting, a full queue, rate limits), 5xx for "never"
 * (no such mailbox, refused relay). Without one, a connection-level code is
 * transient and bad credentials or a rejected envelope are not. Anything
 * unrecognised is retried: the retry budget is bounded, a lost reminder is
 * not recoverable.
 */
export function classifySmtpError(e: unknown): ChannelOutcome {
  const err = (typeof e === 'object' && e !== null ? e : {}) as SmtpError;
  const message =
    typeof err.response === 'string' && err.response !== ''
      ? err.response
      : typeof err.message === 'string'
        ? err.message
        : String(e);
  const detail = message.slice(0, 300);

  if (typeof err.responseCode === 'number') {
    if (err.responseCode >= 500) {
      return { kind: 'failed', error: `SMTP ${err.responseCode}: ${detail}` };
    }
    if (err.responseCode >= 400) {
      return { kind: 'retry', error: `SMTP ${err.responseCode}: ${detail}` };
    }
  }
  if (err.code === 'EAUTH') {
    return { kind: 'failed', error: `SMTP authentication failed: ${detail}` };
  }
  if (err.code === 'EENVELOPE') {
    return { kind: 'failed', error: `SMTP refused the address: ${detail}` };
  }
  if (typeof err.code === 'string' && TRANSIENT_CODES.has(err.code)) {
    return { kind: 'retry', error: `SMTP ${err.code}: ${detail}` };
  }
  return { kind: 'retry', error: detail };
}

/**
 * Sends one email over SMTP. NEVER THROWS: every outcome is classified and
 * returned, and the dispatcher decides what a failure turns into.
 */
@Injectable()
export class SmtpEmailClient implements EmailSender {
  private static readonly log = new Logger(SmtpEmailClient.name);
  private transport: Transporter | null = null;
  private transportFor = '';

  configured(): boolean {
    return smtpConfig() !== null;
  }

  async send(message: EmailMessage): Promise<ChannelOutcome> {
    const config = smtpConfig();
    if (config === null) {
      return { kind: 'skipped', reason: 'email_not_configured' };
    }

    try {
      const info = (await this.transporter(config).sendMail({
        from: { name: config.fromName, address: config.fromAddress },
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })) as { messageId?: unknown };
      return {
        kind: 'sent',
        ref: typeof info.messageId === 'string' ? info.messageId : null,
      };
    } catch (e) {
      const outcome = classifySmtpError(e);
      // ERROR from the first failure (CLAUDE.md 9): a misconfigured relay
      // otherwise fails quietly for every customer until someone asks why.
      SmtpEmailClient.log.error(
        `email to customer failed (${outcome.kind}): ` +
          (outcome.kind === 'retry' || outcome.kind === 'failed'
            ? outcome.error
            : ''),
      );
      return outcome;
    }
  }

  /** One transport per configuration, rebuilt only if the settings change. */
  private transporter(config: SmtpConfig): Transporter {
    const key = JSON.stringify(config);
    if (this.transport === null || this.transportFor !== key) {
      this.transport = this.createTransport(config);
      this.transportFor = key;
    }
    return this.transport;
  }

  /** Overridden in the spec; nothing else should need to. */
  protected createTransport(config: SmtpConfig): Transporter {
    return createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user === ''
        ? {}
        : { auth: { user: config.user, pass: config.pass } }),
      // Bounded, so one dead relay cannot hold a dispatch batch past its
      // lease. Ten seconds to connect, ten for the greeting, twenty idle.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
}
