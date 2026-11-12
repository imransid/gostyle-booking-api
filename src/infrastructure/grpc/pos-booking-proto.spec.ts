import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSync,
  type MessageTypeDefinition,
  type ServiceDefinition,
} from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import { posBookingIntakeClientOptions } from './pos-booking-grpc.constants';

/**
 * proto/pos_booking.proto and proto/services.proto are PLATFORM'S FILES,
 * copied byte for byte. Platform owns the contract
 * (gostyle-platform docs/booking-pos-tickets-plan.md §8), so this repo never
 * edits its copies: change platform's, then copy them again.
 *
 * When a hash fails, either somebody edited our copy (undo it), or platform
 * changed the file and it was copied again: the day to read what changed,
 * then update the hash. From the folder above both repos:
 *
 *   cmp gostyle-platform/apps/gostyle-api/proto/pos_booking.proto \
 *       gostyle-booking-api/proto/pos_booking.proto
 *   cmp gostyle-platform/apps/gostyle-api/proto/services.proto \
 *       gostyle-booking-api/proto/services.proto
 */
const POS_BOOKING_PROTO_SHA256 =
  '9956abfe66da44bdea84a79c0f5a59c6507bd71a5ef5f092e00cc822d88563a4';
const SERVICES_PROTO_SHA256 =
  '5dc7ece712719ade00b9a798b46aea384f4ec63f7c0c86621561245d37d900db';

const options = posBookingIntakeClientOptions();

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function service(): ServiceDefinition {
  const definition = loadSync(options.protoPath, options.loader);
  const svc = definition[`${options.package}.PosBookingIntake`] as
    ServiceDefinition | undefined;
  if (svc === undefined) throw new Error('no PosBookingIntake');
  return svc;
}

/** [name, number, type] of every field, in declaration order. */
function fieldsOf(
  message: MessageTypeDefinition<object, object>,
): [string, number, string][] {
  const descriptor = message.type as {
    field: { name: string; number: number; type: string }[];
  };
  return descriptor.field.map((f) => [f.name, f.number, f.type]);
}

describe('pos_booking.proto: platform PosBookingIntake, as this client loads it', () => {
  it('is platform’s file byte for byte', () => {
    expect(
      sha256(options.protoPath),
      'proto/pos_booking.proto is not the pinned copy of platform’s: see ' +
        'the top of pos-booking-proto.spec.ts',
    ).toBe(POS_BOOKING_PROTO_SHA256);
  });

  it('services.proto (GetTaxSettings) is platform’s file byte for byte', () => {
    expect(sha256(join(process.cwd(), 'proto/services.proto'))).toBe(
      SERVICES_PROTO_SHA256,
    );
  });

  it('serves the three unary calls at the paths platform serves', () => {
    const svc = service();
    expect(Object.keys(svc).sort()).toEqual([
      'GetTicketForBooking',
      'OpenTicketForBooking',
      'UpdateBookingStatus',
    ]);
    expect(svc.OpenTicketForBooking!.path).toBe(
      '/gostyle.pos.booking.v1.PosBookingIntake/OpenTicketForBooking',
    );
  });

  it('pins the open request, name and number', () => {
    expect(fieldsOf(service().OpenTicketForBooking!.requestType)).toEqual([
      ['tenant_id', 1, 'TYPE_STRING'],
      ['branch_id', 2, 'TYPE_STRING'],
      ['booking_id', 3, 'TYPE_STRING'],
      ['booking_code', 4, 'TYPE_STRING'],
      ['start_at', 5, 'TYPE_STRING'],
      ['opened_by_user_id', 6, 'TYPE_STRING'],
      ['customer', 7, 'TYPE_MESSAGE'],
      ['items', 8, 'TYPE_MESSAGE'],
      ['products', 9, 'TYPE_MESSAGE'],
      ['deposit_available_minor', 10, 'TYPE_INT32'],
      ['deposit_vat_minor', 11, 'TYPE_INT32'],
      ['idempotency_key', 12, 'TYPE_STRING'],
    ]);
  });

  it('pins the status request, name and number', () => {
    expect(fieldsOf(service().UpdateBookingStatus!.requestType)).toEqual([
      ['tenant_id', 1, 'TYPE_STRING'],
      ['booking_id', 2, 'TYPE_STRING'],
      ['status', 3, 'TYPE_STRING'],
      ['deposit_available_minor', 4, 'TYPE_INT32'],
      ['deposit_vat_minor', 5, 'TYPE_INT32'],
      ['actor_user_id', 6, 'TYPE_STRING'],
      ['idempotency_key', 7, 'TYPE_STRING'],
    ]);
  });

  // keepCase + defaults: every field comes back under its snake_case name,
  // an absent one as '' or 0 -- never a missing key.
  it('round-trips an open request and reads an empty answer as blanks', () => {
    const open = service().OpenTicketForBooking!;
    const request = {
      tenant_id: '0190f0c1-1111-7000-8000-000000000001',
      branch_id: '0190f0c1-3333-7000-8000-000000000003',
      booking_id: '0190f0c1-2222-7000-8000-000000000002',
      booking_code: 'GS-1234',
      start_at: '2026-11-04T10:00:00.000Z',
      opened_by_user_id: '',
      customer: { consumer_id: '', email: '', full_name: '' },
      items: [
        {
          booking_item_id: '0190f0c1-7777-7000-8000-000000000007',
          service_id: '0190f0c1-8888-7000-8000-000000000008',
          service_name: 'Cut',
          staff_profile_id: '0190f0c1-9999-7000-8000-000000000009',
          price_minor: 20000,
          duration_min: 45,
        },
      ],
      products: [],
      deposit_available_minor: 5000,
      deposit_vat_minor: 238,
      idempotency_key: 'booking:x:open:y',
    };
    expect(open.requestDeserialize(open.requestSerialize(request))).toEqual(
      request,
    );
    expect(open.responseDeserialize(Buffer.alloc(0))).toEqual({
      ticket_id: '',
      number: '',
      state: '',
      replayed: false,
    });
  });
});
