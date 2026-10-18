import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';

import { GrpcServicesDirectory } from './grpc-services-directory';

/**
 * ADAPTER SPEC for ListPackages -- the wire-to-port mapping and what each
 * failure means. It had no spec at all; the review found the mapping was
 * only ever proven by the live journey.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';
const SVC = '66666666-6666-6666-6666-666666666660';
const VARIANT = '33333333-3333-4333-8333-333333333333';

const grpc = (code: number) => Object.assign(new Error('wire'), { code });

type Answer = Observable<{ packages?: Record<string, unknown>[] }>;

function directoryAnswering(answer: () => Answer) {
  const listPackages = vi.fn<(request: unknown) => Answer>(answer);
  const client = {
    getService: vi.fn(() => ({ listPackages })),
  } as unknown as ClientGrpc;
  const directory = new GrpcServicesDirectory(client);
  directory.onModuleInit();
  return { directory, listPackages };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('GrpcServicesDirectory.listPackages: wire to port', () => {
  it('maps every field, the variant and the live-menu marker included', async () => {
    const { directory, listPackages } = directoryAnswering(() =>
      of({
        packages: [
          {
            package_id: 'pkg-1',
            name: 'Groom and Go',
            price_minor: 37000,
            currency: 'AED',
            items: [
              { service_id: SVC, quantity: 2, variant_id: VARIANT },
              { service_id: SVC, quantity: 1, variant_id: '' },
            ],
            from_published_snapshot: true,
          },
        ],
      }),
    );
    await expect(directory.listPackages(TENANT, BRANCH)).resolves.toEqual([
      {
        id: 'pkg-1',
        name: 'Groom and Go',
        priceMinor: 37000,
        currency: 'AED',
        items: [
          { serviceId: SVC, quantity: 2, variantId: VARIANT },
          { serviceId: SVC, quantity: 1, variantId: '' },
        ],
        fromPublishedSnapshot: true,
      },
    ]);
    expect(listPackages.mock.calls[0]![0]).toEqual({
      tenant_id: TENANT,
      branch_id: BRANCH,
    });
  });

  it('reads an older platform, which sends no marker, as not the live menu', async () => {
    const { directory } = directoryAnswering(() =>
      of({ packages: [{ package_id: 'pkg-1', items: [] }] }),
    );
    const [pkg] = await directory.listPackages(TENANT, BRANCH);
    expect(pkg!.fromPublishedSnapshot).toBe(false);
  });
});

describe('GrpcServicesDirectory.listPackages: what a failure means', () => {
  it('a platform with no ListPackages sells no packages, rather than a 503', async () => {
    const { directory } = directoryAnswering(() =>
      throwError(() => grpc(status.UNIMPLEMENTED)),
    );
    await expect(directory.listPackages(TENANT, BRANCH)).resolves.toEqual([]);
  });

  it('a platform that is down is a dependency outage', async () => {
    const { directory } = directoryAnswering(() =>
      throwError(() => grpc(status.UNAVAILABLE)),
    );
    await expect(directory.listPackages(TENANT, BRANCH)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });

  it('a request the platform refuses is ours to fix, not hidden', async () => {
    const { directory } = directoryAnswering(() =>
      throwError(() => grpc(status.INVALID_ARGUMENT)),
    );
    await expect(directory.listPackages(TENANT, BRANCH)).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
  });
});
