import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpcProxy,
} from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';

import { GrpcStaffDirectory } from './grpc-staff-directory';
import { staffDirectoryClientOptions } from './staff-grpc.constants';

/**
 * namesOf AGAINST A REAL PLATFORM, through the client options the module
 * uses (staff.proto, keepCase). Read-only. Skipped unless
 * LIVE_PLATFORM_GRPC_ADDR is set:
 *
 *   LIVE_PLATFORM_GRPC_ADDR=localhost:50052 \
 *     pnpm exec vitest run src/infrastructure/grpc/grpc-staff-directory.live.spec.ts
 *
 * LIVE_STAFF_TENANT names a tenant with staff; the default is the one
 * staffed tenant in the local platform's data.
 */
const ADDR = process.env.LIVE_PLATFORM_GRPC_ADDR ?? '';
const TENANT =
  process.env.LIVE_STAFF_TENANT ?? '11111111-1111-1111-1111-111111111111';

interface Row {
  user_id?: string;
  first_name?: string;
  last_name?: string;
}

describe.skipIf(ADDR === '')('staff directory names, live', () => {
  const saved = process.env.PLATFORM_GRPC_ADDR;
  let client: ClientGrpcProxy;
  let names: GrpcStaffDirectory;
  /** A staff member platform has, read straight off the wire. */
  let someone: Row;

  beforeAll(async () => {
    process.env.PLATFORM_GRPC_ADDR = ADDR;
    client = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: staffDirectoryClientOptions(),
    });
    names = new GrpcStaffDirectory(client);
    names.onModuleInit();

    const raw = client.getService<{
      listStylists(req: object): Observable<{ stylists?: Row[] }>;
    }>('StaffDirectory');
    const res = await firstValueFrom(
      raw.listStylists({ tenant_id: TENANT, branch_id: '' }),
    );
    const found = (res.stylists ?? []).find((r) => (r.user_id ?? '') !== '');
    if (found === undefined) {
      throw new Error(`Tenant ${TENANT} has no staff with a user id here.`);
    }
    someone = found;
  });

  afterAll(() => {
    client?.close();
    if (saved === undefined) delete process.env.PLATFORM_GRPC_ADDR;
    else process.env.PLATFORM_GRPC_ADDR = saved;
  });

  it('a desk member by user id, beside one platform has never heard of', async () => {
    // Case is the unit spec's to prove: the local user ids are all digits.
    const id = someone.user_id as string;
    const nobody = '0192a3b4-dead-7000-8000-00000000beef';

    const out = await names.namesOf(TENANT, [id, nobody], {
      quickMs: 2_000,
    });

    expect(out).toEqual({
      kind: 'answered',
      names: new Map([
        [
          id.toLowerCase(),
          {
            firstName: someone.first_name || null,
            lastName: someone.last_name || null,
          },
        ],
      ]),
    });
  });

  it('a tenant that is not a uuid: an answer with no names (INVALID_ARGUMENT)', async () => {
    await expect(
      names.namesOf('marina-walk', [someone.user_id as string], {
        quickMs: 2_000,
      }),
    ).resolves.toEqual({ kind: 'answered', names: new Map() });
  });

  it('nobody at that address: unavailable, inside quickMs', async () => {
    process.env.PLATFORM_GRPC_ADDR = 'localhost:1';
    const dead = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: staffDirectoryClientOptions(),
    });
    process.env.PLATFORM_GRPC_ADDR = ADDR;
    const nowhere = new GrpcStaffDirectory(dead);
    nowhere.onModuleInit();
    const started = Date.now();

    const out = await nowhere.namesOf(TENANT, [someone.user_id as string], {
      quickMs: 300,
    });

    expect(out.kind).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
    dead.close();
  });
});
