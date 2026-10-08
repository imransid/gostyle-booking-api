import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  loadSync,
  type MessageTypeDefinition,
  type MethodDefinition,
  type ServiceDefinition,
} from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import { chairDirectoryClientOptions } from './floor-grpc.constants';

/**
 * proto/floor.proto is PLATFORM'S FILE, copied byte for byte. Platform owns
 * the contract (gostyle-platform docs/chair-directory-team.md), so this repo
 * never edits its copy: change platform's, then copy it again.
 *
 * The hash is platform's file at 6a2ca47e (PR #178). When it fails, either
 * somebody edited our copy (undo it), or platform changed the file and it
 * was copied again: the day to read what changed, then update the hash.
 * From the folder above both repos:
 *
 *   cmp gostyle-platform/apps/gostyle-api/proto/floor.proto \
 *       gostyle-booking-api/proto/floor.proto
 */
const FLOOR_PROTO_SHA256 =
  '6cbb7d6a2b82b2c148bbd20cbba8c7391b54535df460e4c095994e14f62ea401';

const options = chairDirectoryClientOptions();

function resolveChairQr(): MethodDefinition<object, object> {
  const definition = loadSync(options.protoPath, options.loader);
  const service = definition[`${options.package}.ChairDirectory`] as
    ServiceDefinition | undefined;
  const method = service?.ResolveChairQr;
  if (method === undefined) {
    throw new Error(`no ${options.package}.ChairDirectory.ResolveChairQr`);
  }
  return method;
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

describe('floor.proto: platform ChairDirectory, as this client loads it', () => {
  it('is platform’s file byte for byte', () => {
    const sha256 = createHash('sha256')
      .update(readFileSync(options.protoPath))
      .digest('hex');
    expect(
      sha256,
      'proto/floor.proto is not the pinned copy of platform’s: see the top ' +
        'of floor-proto.spec.ts',
    ).toBe(FLOOR_PROTO_SHA256);
  });

  it('ResolveChairQr is plain unary, at the path platform serves', () => {
    const method = resolveChairQr();
    expect(method.path).toBe('/gostyle.floor.v1.ChairDirectory/ResolveChairQr');
    expect(method.requestStream).toBe(false);
    expect(method.responseStream).toBe(false);
  });

  it('pins every request field, name and number', () => {
    expect(fieldsOf(resolveChairQr().requestType)).toEqual([
      ['token', 1, 'TYPE_STRING'],
      ['user_agent', 2, 'TYPE_STRING'],
    ]);
  });

  it('pins every response field, name and number', () => {
    expect(fieldsOf(resolveChairQr().responseType)).toEqual([
      ['status', 1, 'TYPE_STRING'],
      ['chair_id', 2, 'TYPE_STRING'],
      ['tenant_id', 3, 'TYPE_STRING'],
      ['branch_id', 4, 'TYPE_STRING'],
      ['chair_number', 5, 'TYPE_STRING'],
      ['zone_id', 6, 'TYPE_STRING'],
      ['zone_name', 7, 'TYPE_STRING'],
      ['chair_state', 8, 'TYPE_STRING'],
      ['chair_bookable', 9, 'TYPE_BOOL'],
    ]);
  });

  // keepCase. Without it the names come back camelCase (chairBookable), and
  // every snake_case read of the answer is undefined, with no error.
  it('round-trips a whole response under its snake_case names', () => {
    const method = resolveChairQr();
    const response = {
      status: 'LIVE',
      chair_id: '0192a3b4-0000-7000-8000-000000000001',
      tenant_id: '11111111-1111-1111-1111-111111111111',
      branch_id: '22222222-2222-2222-2222-222222222222',
      chair_number: '7',
      zone_id: '0192a3b4-0000-7000-8000-000000000002',
      zone_name: 'Window section',
      chair_state: 'ACTIVE',
      chair_bookable: true,
    };
    expect(
      method.responseDeserialize(method.responseSerialize(response)),
    ).toEqual(response);

    const request = {
      token: 'q7Xk2mP9rT4vW8yZ1aB3cD',
      user_agent: 'GoStyle/1',
    };
    expect(method.requestDeserialize(method.requestSerialize(request))).toEqual(
      request,
    );
  });

  // defaults. proto3 has no null: platform's "absent" is '' (and false). A
  // missing key would be a third case for every reader to handle.
  it('reads every absent value as empty, never as a missing key', () => {
    const method = resolveChairQr();
    expect(method.responseDeserialize(Buffer.alloc(0))).toEqual({
      status: '',
      chair_id: '',
      tenant_id: '',
      branch_id: '',
      chair_number: '',
      zone_id: '',
      zone_name: '',
      chair_state: '',
      chair_bookable: false,
    });
  });
});
