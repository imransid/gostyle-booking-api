import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  CheckInAttributionHandler,
  NAME_OUTAGE_SKIP_MS,
} from './check-in-attribution.handler';
import {
  SCREEN_NAME_CAP_MS,
  SCREEN_NAME_LOOKUP_MS,
} from '@application/contract/screen-names';
import type { HistoryEntry } from '@domain/booking/check-in-attribution';
import type { StaffNamesLookup } from '@application/ports/staff-directory.port';

const TENANT = 'f2a9882b-c822-4107-b650-29af2e303c24';
const LAYLA = 'aaaaaaaa-0000-4000-8000-00000000a990';
const AT = Date.UTC(2026, 9, 11, 10, 24);

const booked: HistoryEntry = {
  fromStatus: null,
  toStatus: 'confirmed',
  atMs: AT - 60 * 60_000,
  actorKind: 'customer',
  actorId: null,
  via: null,
};
const checkedIn = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  fromStatus: 'confirmed',
  toStatus: 'checked_in',
  atMs: AT,
  actorKind: 'staff',
  actorId: LAYLA,
  via: 'self',
  ...over,
});

function reader(opts: {
  facts?: { tenantId: string | null; history: HistoryEntry[] } | null;
  names?: () => Promise<StaffNamesLookup>;
}) {
  const requests = {
    checkInFactsOf: vi.fn(() =>
      Promise.resolve(
        opts.facts === undefined
          ? { tenantId: TENANT, history: [booked, checkedIn()] }
          : opts.facts,
      ),
    ),
  };
  const staff = {
    namesOf: vi.fn(
      (_tenant: string, _ids: readonly string[], _o: { quickMs: number }) =>
        opts.names?.() ??
        Promise.resolve<StaffNamesLookup>({
          kind: 'answered',
          names: new Map([[LAYLA, { firstName: 'Layla', lastName: 'Rahman' }]]),
        }),
    ),
    listStylists: vi.fn(),
  };
  return {
    r: new CheckInAttributionHandler(requests as never, staff),
    requests,
    staff,
  };
}

describe('CheckInAttributionHandler.ofBooking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const quiet = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  it('when, how and who: "Layla R.", from ONE quick lookup of that one id', async () => {
    const h = reader({});
    await expect(h.r.ofBooking('b-1')).resolves.toEqual({
      at: new Date(AT).toISOString(),
      via: 'SELF',
      byName: 'Layla R.',
    });
    expect(h.staff.namesOf).toHaveBeenCalledTimes(1);
    expect(h.staff.namesOf).toHaveBeenCalledWith(TENANT, [LAYLA], {
      quickMs: SCREEN_NAME_LOOKUP_MS,
    });
  });

  it.each([
    ['no such booking', null],
    ['never checked in', { tenantId: TENANT, history: [booked] }],
  ])('%s: null, and platform is never asked', async (_, facts) => {
    const h = reader({ facts });
    await expect(h.r.ofBooking('b-1')).resolves.toBeNull();
    expect(h.staff.namesOf).not.toHaveBeenCalled();
  });

  it('a row that names no desk member: the welcome without a name, nothing asked', async () => {
    const h = reader({
      facts: {
        tenantId: TENANT,
        history: [booked, checkedIn({ actorId: null, via: 'staff' })],
      },
    });
    await expect(h.r.ofBooking('b-1')).resolves.toEqual({
      at: new Date(AT).toISOString(),
      via: 'STAFF',
      byName: null,
    });
    expect(h.staff.namesOf).not.toHaveBeenCalled();
  });

  it('a booking with no tenant: no tenant to ask in, nothing asked', async () => {
    const h = reader({
      facts: { tenantId: null, history: [booked, checkedIn()] },
    });
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      byName: null,
    });
    expect(h.staff.namesOf).not.toHaveBeenCalled();
  });

  it('a check-in from before `via` was recorded: via null, not STAFF', async () => {
    const h = reader({
      facts: { tenantId: TENANT, history: [booked, checkedIn({ via: null })] },
    });
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      via: null,
      byName: 'Layla R.',
    });
  });

  it('no staff profile: null, and nothing logged (an answer, not a fault)', async () => {
    const warn = quiet();
    const h = reader({
      names: () => Promise.resolve({ kind: 'answered', names: new Map() }),
    });
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      byName: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a profile with no first name: null', async () => {
    const h = reader({
      names: () =>
        Promise.resolve({
          kind: 'answered',
          names: new Map([[LAYLA, { firstName: null, lastName: 'Rahman' }]]),
        }),
    });
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      byName: null,
    });
  });

  it('platform unavailable: the welcome without a name, and ONE log line', async () => {
    const warn = quiet();
    const h = reader({
      names: () =>
        Promise.resolve({ kind: 'unavailable', error: 'platform 14 down' }),
    });
    await expect(h.r.ofBooking('b-1')).resolves.toEqual({
      at: new Date(AT).toISOString(),
      via: 'SELF',
      byName: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('platform 14 down');
  });

  it('an adapter that throws: the same, never the read failing', async () => {
    const warn = quiet();
    const h = reader({ names: () => Promise.reject(new Error('boom')) });
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      byName: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('after platform fails to answer, the next reads do not wait on it for 30s, then it is asked again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const warn = quiet();
    let up = false;
    const h = reader({
      names: () =>
        up
          ? Promise.resolve<StaffNamesLookup>({
              kind: 'answered',
              names: new Map([[LAYLA, { firstName: 'Layla', lastName: 'R' }]]),
            })
          : Promise.resolve({ kind: 'unavailable', error: 'platform 14 down' }),
    });

    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({ byName: null });
    expect(h.staff.namesOf).toHaveBeenCalledTimes(1);

    // Inside the window, platform back or not: not asked, and nothing logged.
    up = true;
    vi.setSystemTime(AT + NAME_OUTAGE_SKIP_MS - 1);
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      via: 'SELF',
      byName: null,
    });
    expect(h.staff.namesOf).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // The window over: asked again, and the name is back.
    vi.setSystemTime(AT + NAME_OUTAGE_SKIP_MS);
    await expect(h.r.ofBooking('b-1')).resolves.toMatchObject({
      byName: 'Layla R.',
    });
    expect(h.staff.namesOf).toHaveBeenCalledTimes(2);
  });

  it('an answer with no profile opens no window: the next read asks again', async () => {
    const h = reader({
      names: () => Promise.resolve({ kind: 'answered', names: new Map() }),
    });
    await h.r.ofBooking('b-1');
    await h.r.ofBooking('b-1');
    expect(h.staff.namesOf).toHaveBeenCalledTimes(2);
  });

  it('platform silent: the read goes out at the cap, not a moment later, with ONE log line', async () => {
    vi.useFakeTimers();
    const warn = quiet();
    const h = reader({ names: () => new Promise<StaffNamesLookup>(() => {}) });
    let out: unknown = 'pending';
    void h.r.ofBooking('b-1').then((v) => (out = v));

    await vi.advanceTimersByTimeAsync(SCREEN_NAME_CAP_MS - 1);
    expect(out).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toMatchObject({ via: 'SELF', byName: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
