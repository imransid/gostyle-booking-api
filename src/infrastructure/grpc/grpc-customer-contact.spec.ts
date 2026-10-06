import { afterEach, describe, it, expect, vi } from 'vitest';
import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';
import { GrpcCustomerContact } from './grpc-customer-contact';

const CUSTOMER = '22222222-2222-4222-8222-222222222222';

function build(reply: () => Observable<unknown>) {
  const getConsumerContact = vi.fn(
    (_data: unknown, _md: Metadata, _opts: unknown) => reply(),
  );
  const client = { getService: vi.fn(() => ({ getConsumerContact })) };
  const adapter = new GrpcCustomerContact(client as never);
  adapter.onModuleInit();
  return { adapter, getConsumerContact };
}

const grpcError = (code: number, details = '') =>
  Object.assign(new Error(details), { code, details });

const savedKey = process.env.INTERNAL_GRPC_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.INTERNAL_GRPC_KEY;
  else process.env.INTERNAL_GRPC_KEY = savedKey;
});

describe('found', () => {
  it('an email, its verification and the preferences', async () => {
    const { adapter } = build(() =>
      of({
        found: true,
        consumer_id: CUSTOMER,
        email: 'sara@example.com',
        email_verified: true,
        full_name: 'Sara Ahmed',
        language: 'en',
        appointment_reminder: true,
        push_enabled: true,
      }),
    );
    expect(await adapter.lookup(CUSTOMER)).toEqual({
      kind: 'found',
      contact: {
        customerId: CUSTOMER,
        email: 'sara@example.com',
        emailVerified: true,
        fullName: 'Sara Ahmed',
        appointmentReminder: true,
        pushEnabled: true,
      },
    });
  });

  it('a customer with no email: found, email null', async () => {
    // proto3 leaves empty strings and false off the wire entirely.
    const { adapter } = build(() =>
      of({
        found: true,
        consumer_id: CUSTOMER,
        appointment_reminder: true,
        push_enabled: true,
      }),
    );
    const got = await adapter.lookup(CUSTOMER);
    expect(got.kind === 'found' && got.contact.email).toBeNull();
    expect(got.kind === 'found' && got.contact.emailVerified).toBe(false);
  });
});

describe('not found', () => {
  it('found=false is an ordinary answer', async () => {
    const { adapter } = build(() => of({ found: false }));
    expect(await adapter.lookup(CUSTOMER)).toEqual({ kind: 'not_found' });
  });

  it('INVALID_ARGUMENT: an id that is not one will not become one', async () => {
    const { adapter } = build(() =>
      throwError(() => grpcError(status.INVALID_ARGUMENT)),
    );
    expect(await adapter.lookup('anonymous')).toEqual({ kind: 'not_found' });
  });
});

describe('unavailable: no answer, so the email retries', () => {
  it.each([
    ['DEADLINE_EXCEEDED', status.DEADLINE_EXCEEDED],
    ['INTERNAL', status.INTERNAL],
    ['UNKNOWN (a Python server whose database dropped)', status.UNKNOWN],
    [
      'UNIMPLEMENTED (customer-api not yet deployed with the call)',
      status.UNIMPLEMENTED,
    ],
    ['UNAUTHENTICATED (the key is missing or wrong)', status.UNAUTHENTICATED],
  ])('%s', async (_name, code) => {
    const { adapter } = build(() => throwError(() => grpcError(code, 'nope')));
    const got = await adapter.lookup(CUSTOMER);
    expect(got.kind).toBe('unavailable');
  });

  it('UNAVAILABLE is retried once in-line, then reported', async () => {
    const { adapter, getConsumerContact } = build(() =>
      throwError(() => grpcError(status.UNAVAILABLE, 'connection refused')),
    );
    const got = await adapter.lookup(CUSTOMER);
    expect(got).toEqual({
      kind: 'unavailable',
      error: 'customer-api UNAVAILABLE: connection refused',
    });
    expect(getConsumerContact).toHaveBeenCalledTimes(2);
  });
});

describe('the internal key', () => {
  it('is sent as x-internal-key metadata', async () => {
    process.env.INTERNAL_GRPC_KEY = 'k-123';
    const { adapter, getConsumerContact } = build(() => of({ found: false }));
    await adapter.lookup(CUSTOMER);
    const md = getConsumerContact.mock.calls[0]![1];
    expect(md.get('x-internal-key')).toEqual(['k-123']);
  });

  it('asks for exactly the customer it was given', async () => {
    const { adapter, getConsumerContact } = build(() => of({ found: false }));
    await adapter.lookup(CUSTOMER);
    expect(getConsumerContact.mock.calls[0]![0]).toEqual({
      consumer_id: CUSTOMER,
    });
  });
});
