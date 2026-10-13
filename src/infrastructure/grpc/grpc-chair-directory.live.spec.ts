import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpcProxy,
} from '@nestjs/microservices';

import { GrpcChairDirectory } from './grpc-chair-directory';
import { chairDirectoryClientOptions } from './floor-grpc.constants';

/**
 * THE CHAIR ADAPTER AGAINST A REAL PLATFORM, through the client options the
 * module uses (floor.proto, keepCase). Skipped unless LIVE_PLATFORM_GRPC_ADDR
 * is set:
 *
 *   LIVE_PLATFORM_GRPC_ADDR=localhost:50152 \
 *   LIVE_PLATFORM_KEY=<platform's PLATFORM_INTERNAL_KEY> \
 *     pnpm exec vitest run src/infrastructure/grpc/grpc-chair-directory.live.spec.ts
 *
 * Made-up and empty tokens only, so platform writes NO scan row. A real card
 * is one more, opt-in: LIVE_CHAIR_TOKEN, which DOES write a scan row in that
 * platform's registry, as every real scan does.
 */
const ADDR = process.env.LIVE_PLATFORM_GRPC_ADDR ?? '';
const KEY = process.env.LIVE_PLATFORM_KEY ?? 'dev-platform-internal-key';
const REAL_CARD = process.env.LIVE_CHAIR_TOKEN ?? '';

describe.skipIf(ADDR === '')('chair directory, live', () => {
  let client: ClientGrpcProxy;
  const saved = {
    addr: process.env.PLATFORM_GRPC_ADDR,
    key: process.env.PLATFORM_INTERNAL_KEY,
  };

  /** A new adapter: its once-per-process memory starts empty. */
  function adapter(): GrpcChairDirectory {
    const a = new GrpcChairDirectory(client);
    a.onModuleInit();
    return a;
  }

  beforeAll(() => {
    process.env.PLATFORM_GRPC_ADDR = ADDR;
    client = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: chairDirectoryClientOptions(),
    });
  });

  afterAll(() => {
    client?.close();
    vi.restoreAllMocks();
    for (const [name, value] of [
      ['PLATFORM_GRPC_ADDR', saved.addr],
      ['PLATFORM_INTERNAL_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('a token platform never minted: unknown_card', async () => {
    process.env.PLATFORM_INTERNAL_KEY = KEY;
    await expect(
      adapter().resolve('never-minted-booking-api-live', 'live-spec'),
    ).resolves.toEqual({ kind: 'unknown_card' });
  });

  it('an empty token: unknown_card (platform says INVALID_ARGUMENT)', async () => {
    process.env.PLATFORM_INTERNAL_KEY = KEY;
    await expect(adapter().resolve('', null)).resolves.toEqual({
      kind: 'unknown_card',
    });
  });

  it('a wrong key: unavailable, and ONE error line over two scans, without the key', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    process.env.PLATFORM_INTERNAL_KEY = 'not-the-key-live-spec';
    const a = adapter();
    for (let i = 0; i < 2; i++) {
      await expect(
        a.resolve('never-minted-booking-api-live', null),
      ).resolves.toEqual({
        kind: 'unavailable',
        error: 'platform UNAUTHENTICATED: missing or wrong x-internal-key',
      });
    }
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('PLATFORM_INTERNAL_KEY');
    expect(line).toContain('until the service restarts');
    expect(line).not.toContain('not-the-key-live-spec');
    error.mockRestore();
  });

  it.skipIf(REAL_CARD === '')(
    'a real card: found, every field read back (writes one scan row)',
    async () => {
      process.env.PLATFORM_INTERNAL_KEY = KEY;
      const got = await adapter().resolve(REAL_CARD, 'booking-api live spec');
      expect(got.kind).toBe('found');
      if (got.kind !== 'found') return;
      expect(got.chair.chairId).toMatch(/^[0-9a-f-]{36}$/);
      expect(got.chair.tenantId).toMatch(/^[0-9a-f-]{36}$/);
      expect(['LIVE', 'REPLACED', 'INACTIVE', 'RETIRED']).toContain(
        got.chair.cardStatus,
      );
      expect(typeof got.chair.chairBookable).toBe('boolean');
    },
  );
});
