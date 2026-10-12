import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure, grpcStatusOf } from './grpc-failure';
import type {
  ContactLookup,
  CustomerContactReader,
} from '@application/ports/customer-contact.port';

/** Injection token for the raw client; CUSTOMER_CONTACT names the port. */
export const CONSUMER_DIRECTORY_CLIENT = 'CONSUMER_DIRECTORY_CLIENT';

/**
 * The wire shape, snake_case, exactly as consumer_directory.proto declares
 * it. Optional because proto3 leaves defaults off the wire: an empty email
 * arrives as a missing key, and `false` as nothing at all.
 */
interface ConsumerContactWire {
  found?: boolean;
  consumer_id?: string;
  email?: string;
  email_verified?: boolean;
  full_name?: string;
  language?: string;
  appointment_reminder?: boolean;
  push_enabled?: boolean;
}

interface ConsumerDirectoryGrpc {
  getConsumerContact(
    data: { consumer_id: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<ConsumerContactWire>;
}

/**
 * Short. A contact lookup is one indexed read; anything slower is customer-api
 * in trouble, and the email waiting on it will be retried by the dispatcher.
 */
const CALL_TIMEOUT_MS = 2_000;

/**
 * Codes that mean THIS SERVICE is misconfigured or out of step, not that
 * customer-api is busy: no key, a wrong key, a customer-api not yet deployed
 * with the call. Still retried -- a deploy usually fixes them within the
 * retry window -- but logged at ERROR, because nobody else will notice.
 */
const MISCONFIGURED: ReadonlySet<number> = new Set<number>([
  status.UNAUTHENTICATED,
  status.PERMISSION_DENIED,
  status.UNIMPLEMENTED,
]);

/**
 * CUSTOMER_CONTACT over gRPC to customer-api's ConsumerDirectory.
 *
 * Three answers, kept apart because they lead to different places:
 *
 *   found        an email to write to, or none, and the preferences
 *   not_found    no such customer; INVALID_ARGUMENT lands here too, since an
 *                id that is not one will not become one on a retry
 *   unavailable  no answer at all; the email retries later
 */
@Injectable()
export class GrpcCustomerContact
  implements CustomerContactReader, OnModuleInit
{
  private readonly logger = new Logger(GrpcCustomerContact.name);
  private svc!: ConsumerDirectoryGrpc;

  constructor(
    @Inject(CONSUMER_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc =
      this.client.getService<ConsumerDirectoryGrpc>('ConsumerDirectory');
  }

  async lookup(customerId: string): Promise<ContactLookup> {
    // Read per call, like every other setting here: .env is loaded after
    // this module, and a key rotation should need a restart, not a rebuild.
    const key = (process.env.INTERNAL_GRPC_KEY ?? '').trim();

    try {
      const res = await callWithRetry(
        this.logger,
        `getConsumerContact ${customerId.slice(0, 8)}`,
        CALL_TIMEOUT_MS,
        (md, opts) => {
          if (key !== '') md.set('x-internal-key', key);
          return this.svc.getConsumerContact(
            { consumer_id: customerId },
            md,
            opts,
          );
        },
      );

      if (res.found !== true) return { kind: 'not_found' };

      return {
        kind: 'found',
        contact: {
          customerId: res.consumer_id || customerId,
          email: nonEmpty(res.email),
          emailVerified: res.email_verified === true,
          fullName: nonEmpty(res.full_name),
          appointmentReminder: res.appointment_reminder === true,
          pushEnabled: res.push_enabled === true,
        },
      };
    } catch (e) {
      const code = grpcStatusOf(e);
      if (code === status.INVALID_ARGUMENT || code === status.NOT_FOUND) {
        return { kind: 'not_found' };
      }
      const error = `customer-api ${describeGrpcFailure(e)}`;
      if (code !== null && MISCONFIGURED.has(code)) {
        this.logger.error(
          `${error} -- check INTERNAL_GRPC_KEY on both sides and that ` +
            'customer-api serves ConsumerDirectory',
        );
      }
      return { kind: 'unavailable', error };
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}
