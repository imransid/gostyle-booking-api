import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { NEVER, of, throwError } from 'rxjs';

import { GrpcStaffDirectory } from './grpc-staff-directory';

/**
 * namesOf, the quick lookup for a screen, with the gRPC client faked. What
 * a real platform answers is grpc-staff-directory.live.spec.ts's question.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const LAYLA = 'aaaaaaaa-0000-4000-8000-00000000a990';
const OMAR = 'bbbbbbbb-0000-4000-8000-00000000b991';

function adapter(answer: () => unknown) {
  const listStylists = vi.fn(
    (_request: { tenant_id: string; branch_id: string }) => answer(),
  );
  const client = { getService: () => ({ listStylists }) };
  const a = new GrpcStaffDirectory(client as never);
  a.onModuleInit();
  return { a, listStylists };
}

const roster =
  (...rows: Record<string, string>[]) =>
  () =>
    of({ stylists: rows });

describe('GrpcStaffDirectory.namesOf', () => {
  afterEach(() => vi.restoreAllMocks());

  it('one call for the whole tenant, each id once, matched whatever its case', async () => {
    const h = adapter(
      roster(
        { user_id: LAYLA, first_name: 'Layla', last_name: 'Rahman' },
        { user_id: OMAR.toUpperCase(), first_name: 'Omar', last_name: '' },
        { user_id: 'someone-else', first_name: 'Nour', last_name: 'K' },
      ),
    );

    const out = await h.a.namesOf(TENANT, [LAYLA, OMAR, LAYLA.toUpperCase()], {
      quickMs: 500,
    });

    expect(h.listStylists).toHaveBeenCalledTimes(1);
    // No branch: every branch in the tenant.
    expect(h.listStylists.mock.calls[0]?.[0]).toEqual({
      tenant_id: TENANT,
      branch_id: '',
    });
    expect(out).toEqual({
      kind: 'answered',
      names: new Map([
        [LAYLA, { firstName: 'Layla', lastName: 'Rahman' }],
        // Blank is unknown, not a name.
        [OMAR, { firstName: 'Omar', lastName: null }],
      ]),
    });
  });

  it('an id with no profile is simply not there: an answer, not a failure', async () => {
    const out = await adapter(roster()).a.namesOf(TENANT, [LAYLA], {
      quickMs: 500,
    });
    expect(out).toEqual({ kind: 'answered', names: new Map() });
  });

  it('a user with profiles at two branches: the first', async () => {
    const out = await adapter(
      roster(
        { user_id: LAYLA, first_name: 'Layla', last_name: 'Rahman' },
        { user_id: LAYLA, first_name: 'Layla', last_name: 'R' },
      ),
    ).a.namesOf(TENANT, [LAYLA], { quickMs: 500 });
    expect(out.kind === 'answered' && out.names.get(LAYLA)?.lastName).toBe(
      'Rahman',
    );
  });

  it('no ids: nothing asked', async () => {
    const h = adapter(roster());
    await expect(h.a.namesOf(TENANT, [], { quickMs: 500 })).resolves.toEqual({
      kind: 'answered',
      names: new Map(),
    });
    expect(h.listStylists).not.toHaveBeenCalled();
  });

  it('a tenant platform will not take (INVALID_ARGUMENT): an answer, no names', async () => {
    const h = adapter(() =>
      throwError(() =>
        Object.assign(new Error('tenant_id must be a UUID'), {
          code: status.INVALID_ARGUMENT,
        }),
      ),
    );
    await expect(
      h.a.namesOf('marina-walk', [LAYLA], { quickMs: 500 }),
    ).resolves.toEqual({ kind: 'answered', names: new Map() });
  });

  it('platform down: unavailable, ONE attempt, and no log line of its own', async () => {
    const logged = [
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    ];
    const h = adapter(() =>
      throwError(() =>
        Object.assign(new Error('No connection established'), {
          code: status.UNAVAILABLE,
        }),
      ),
    );

    const out = await h.a.namesOf(TENANT, [LAYLA], { quickMs: 500 });

    expect(out.kind).toBe('unavailable');
    expect(out.kind === 'unavailable' && out.error).toMatch(/^platform /);
    expect(h.listStylists).toHaveBeenCalledTimes(1);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('platform silent: unavailable once quickMs has passed, not at the 5s roster timeout', async () => {
    const h = adapter(() => NEVER);
    const started = Date.now();

    const out = await h.a.namesOf(TENANT, [LAYLA], { quickMs: 50 });

    expect(out.kind).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.listStylists).toHaveBeenCalledTimes(1);
  });
});
