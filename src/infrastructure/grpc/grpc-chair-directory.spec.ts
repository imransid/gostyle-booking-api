import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Logger } from '@nestjs/common';
import { Metadata, status } from '@grpc/grpc-js';
import { NEVER, of, throwError, type Observable } from 'rxjs';

import { GrpcChairDirectory } from './grpc-chair-directory';

const KEY = 'k-platform-123';
const TOKEN = 'q7Xk2mP9rT4vW8yZ1aB3cD';

const LIVE_ANSWER = {
  status: 'LIVE',
  chair_id: '0192a3b4-0000-7000-8000-000000000007',
  tenant_id: 'f2a9882b-c822-4107-b650-29af2e303c24',
  branch_id: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
  chair_number: '7',
  zone_id: '0192a3b4-0000-7000-8000-000000000002',
  zone_name: 'Window section',
  chair_state: 'ACTIVE',
  chair_bookable: true,
};

function build(reply: () => Observable<unknown>) {
  const resolveChairQr = vi.fn(
    (_data: unknown, _md: Metadata, _opts: unknown) => reply(),
  );
  const client = { getService: vi.fn(() => ({ resolveChairQr })) };
  const adapter = new GrpcChairDirectory(client as never);
  adapter.onModuleInit();
  return { adapter, resolveChairQr };
}

const grpcError = (code: number, details = '') =>
  Object.assign(new Error(details), { code, details });

let logs: { warn: MockInstance; error: MockInstance };

const savedKey = process.env.PLATFORM_INTERNAL_KEY;
beforeEach(() => {
  process.env.PLATFORM_INTERNAL_KEY = KEY;
  logs = {
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.PLATFORM_INTERNAL_KEY;
  else process.env.PLATFORM_INTERNAL_KEY = savedKey;
});

const loggedText = (spy: MockInstance): string =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('found', () => {
  it('maps the whole answer onto the port', async () => {
    const { adapter } = build(() => of(LIVE_ANSWER));
    expect(await adapter.resolve(TOKEN, 'GoStyle/1')).toEqual({
      kind: 'found',
      chair: {
        cardStatus: 'LIVE',
        chairId: LIVE_ANSWER.chair_id,
        tenantId: LIVE_ANSWER.tenant_id,
        branchId: LIVE_ANSWER.branch_id,
        chairNumber: '7',
        zoneName: 'Window section',
        chairState: 'ACTIVE',
        chairBookable: true,
      },
    });
  });

  it('reads platform’s absent values ("") as null', async () => {
    // A retired chair: no number, no zone. And a deleted row: no branch, no
    // state. proto3 has no null; '' is platform's absent.
    const { adapter } = build(() =>
      of({
        ...LIVE_ANSWER,
        status: 'RETIRED',
        branch_id: '',
        chair_number: '',
        zone_id: '',
        zone_name: '',
        chair_state: '',
        chair_bookable: false,
      }),
    );
    const got = await adapter.resolve(TOKEN, null);
    expect(got).toMatchObject({
      kind: 'found',
      chair: {
        cardStatus: 'RETIRED',
        branchId: null,
        chairNumber: null,
        zoneName: null,
        chairState: null,
        chairBookable: false,
      },
    });
  });

  it('is bookable only when platform says true', async () => {
    const { adapter } = build(() =>
      of({ ...LIVE_ANSWER, chair_bookable: undefined }),
    );
    const got = await adapter.resolve(TOKEN, null);
    expect(got.kind === 'found' && got.chair.chairBookable).toBe(false);
  });

  it('passes the card status on exactly as platform said it', async () => {
    // The rule compares it exactly: LIVE only. Tidying it here would be
    // deciding for the rule.
    const { adapter } = build(() => of({ ...LIVE_ANSWER, status: 'live ' }));
    const got = await adapter.resolve(TOKEN, null);
    expect(got.kind === 'found' && got.chair.cardStatus).toBe('live ');
  });

  it('refuses an answer with no chair_id: platform broke its contract', async () => {
    const { adapter } = build(() => of({ ...LIVE_ANSWER, chair_id: '' }));
    expect((await adapter.resolve(TOKEN, null)).kind).toBe('unavailable');
    expect(logs.warn).toHaveBeenCalledOnce();
  });
});

describe('what it sends', () => {
  it('the token exactly as scanned, and the app’s user agent', async () => {
    const { adapter, resolveChairQr } = build(() => of(LIVE_ANSWER));
    await adapter.resolve(` ${TOKEN} `, 'GoStyle/1 (iPhone)');
    expect(resolveChairQr.mock.calls[0]![0]).toEqual({
      token: ` ${TOKEN} `,
      user_agent: 'GoStyle/1 (iPhone)',
    });
  });

  it('an unknown user agent as ""', async () => {
    const { adapter, resolveChairQr } = build(() => of(LIVE_ANSWER));
    await adapter.resolve(TOKEN, null);
    expect(resolveChairQr.mock.calls[0]![0]).toEqual({
      token: TOKEN,
      user_agent: '',
    });
  });

  it('PLATFORM_INTERNAL_KEY, trimmed, as x-internal-key', async () => {
    process.env.PLATFORM_INTERNAL_KEY = ` ${KEY}\n`;
    const { adapter, resolveChairQr } = build(() => of(LIVE_ANSWER));
    await adapter.resolve(TOKEN, null);
    const md = resolveChairQr.mock.calls[0]![1];
    expect(md.get('x-internal-key')).toEqual([KEY]);
  });

  it('one call with a deadline of two seconds', async () => {
    const { adapter, resolveChairQr } = build(() => of(LIVE_ANSWER));
    const before = Date.now();
    await adapter.resolve(TOKEN, null);
    expect(resolveChairQr).toHaveBeenCalledTimes(1);
    const opts = resolveChairQr.mock.calls[0]![2] as { deadline: number };
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 2_000);
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 2_000);
  });
});

describe('one attempt: every answered call is a scan row', () => {
  it('UNAVAILABLE: no retry, unavailable, one warn line', async () => {
    const { adapter, resolveChairQr } = build(() =>
      throwError(() => grpcError(status.UNAVAILABLE, 'connection refused')),
    );
    expect(await adapter.resolve(TOKEN, null)).toEqual({
      kind: 'unavailable',
      error: 'platform UNAVAILABLE: connection refused',
    });
    expect(resolveChairQr).toHaveBeenCalledTimes(1);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('no answer at all: unavailable at two seconds, after one call', async () => {
    vi.useFakeTimers();
    const { adapter, resolveChairQr } = build(() => NEVER);
    const pending = adapter.resolve(TOKEN, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).kind).toBe('unavailable');
    expect(resolveChairQr).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['DEADLINE_EXCEEDED', status.DEADLINE_EXCEEDED],
    ['INTERNAL', status.INTERNAL],
    ['UNKNOWN', status.UNKNOWN],
  ])('%s: unavailable, a warn line per scan, no error', async (_n, code) => {
    const { adapter } = build(() => throwError(() => grpcError(code, 'x')));
    await adapter.resolve(TOKEN, null);
    await adapter.resolve(TOKEN, null);
    expect(logs.warn).toHaveBeenCalledTimes(2);
    expect(logs.error).not.toHaveBeenCalled();
  });
});

describe('unknown card: platform wrote no scan', () => {
  it.each([
    ['NOT_FOUND (never minted)', status.NOT_FOUND],
    ['INVALID_ARGUMENT (empty, or over 128)', status.INVALID_ARGUMENT],
  ])('%s', async (_n, code) => {
    const { adapter } = build(() => throwError(() => grpcError(code, 'no')));
    expect(await adapter.resolve(TOKEN, null)).toEqual({
      kind: 'unknown_card',
    });
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });
});

describe('a setup fault: ERROR once per process, not once per scan', () => {
  it('UNAUTHENTICATED: one error line over many scans, naming the key and never its value', async () => {
    const { adapter, resolveChairQr } = build(() =>
      throwError(() =>
        grpcError(status.UNAUTHENTICATED, 'missing or wrong x-internal-key'),
      ),
    );
    for (let i = 0; i < 3; i++) {
      expect((await adapter.resolve(TOKEN, null)).kind).toBe('unavailable');
    }
    expect(resolveChairQr).toHaveBeenCalledTimes(3);
    expect(logs.error).toHaveBeenCalledOnce();
    expect(logs.warn).not.toHaveBeenCalled();
    const line = loggedText(logs.error);
    expect(line).toContain('PLATFORM_INTERNAL_KEY');
    expect(line).toContain('Refused ChairDirectory.ResolveChairQr:');
    // Silence after this line must not read as "fixed".
    expect(line).toContain(
      'this will not be logged again until the service restarts',
    );
    expect(line).not.toContain(KEY);
    expect(line).not.toContain(KEY.slice(0, 6));
  });

  it('UNIMPLEMENTED: once too, and on its own: a later key fault is still told', async () => {
    let code: number = status.UNIMPLEMENTED;
    const { adapter } = build(() => throwError(() => grpcError(code, 'x')));
    await adapter.resolve(TOKEN, null);
    await adapter.resolve(TOKEN, null);
    code = status.UNAUTHENTICATED;
    await adapter.resolve(TOKEN, null);
    await adapter.resolve(TOKEN, null);
    expect(logs.error).toHaveBeenCalledTimes(2);
    expect(loggedText(logs.error)).toContain('UNIMPLEMENTED');
    expect(loggedText(logs.error)).toContain('UNAUTHENTICATED');
  });

  it('no key here: never calls platform, unavailable, one error line', async () => {
    for (const unset of [undefined, '', '   ']) {
      logs.error.mockClear();
      if (unset === undefined) delete process.env.PLATFORM_INTERNAL_KEY;
      else process.env.PLATFORM_INTERNAL_KEY = unset;
      const { adapter, resolveChairQr } = build(() => of(LIVE_ANSWER));
      expect(await adapter.resolve(TOKEN, null)).toEqual({
        kind: 'unavailable',
        error: 'PLATFORM_INTERNAL_KEY is not set',
      });
      await adapter.resolve(TOKEN, null);
      expect(resolveChairQr).not.toHaveBeenCalled();
      expect(logs.error).toHaveBeenCalledOnce();
      expect(loggedText(logs.error)).toContain('not set on booking-api');
    }
  });
});
