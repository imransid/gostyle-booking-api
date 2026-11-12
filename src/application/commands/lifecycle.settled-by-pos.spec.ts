import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { LifecycleHandler } from './lifecycle.handler';
import { isBookingError } from '@application/contract/errors';

const BOOKING = '11111111-1111-4111-8111-111111111111';
const TENANT = '0190f0c1-1111-7000-8000-000000000001';

function setup(ticket: {
  tenantId: string | null;
  posTicketId: string | null;
}) {
  const repo = {
    ticketFor: vi.fn(() =>
      Promise.resolve({
        customerId: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        serviceFils: 20000,
        capturedFils: 5000,
        ...ticket,
      }),
    ),
    timingFor: vi.fn(() => Promise.resolve(null)),
    transition: vi.fn(() =>
      Promise.resolve({
        kind: 'transitioned',
        booking: {
          bookingId: BOOKING,
          code: 'GS-1',
          from: 'completed',
          to: 'settled',
          paymentStatus: 'unchanged',
        },
        money: null,
      }),
    ),
  };
  const customers = {
    load: vi.fn(() => Promise.resolve({ tier: 'standard' })),
  };
  const handler = new LifecycleHandler(repo as never, customers as never);
  const settle = () =>
    handler.execute({
      bookingId: BOOKING,
      to: 'settled',
      actor: 'staff',
      actorId: '33333333-3333-4333-8333-333333333333',
    });
  return { repo, settle };
}

const saved = {
  enabled: process.env.POS_TICKET_SYNC_ENABLED,
  tenants: process.env.POS_TICKET_SYNC_TENANTS,
};
beforeEach(() => {
  delete process.env.POS_TICKET_SYNC_ENABLED;
  delete process.env.POS_TICKET_SYNC_TENANTS;
});
afterEach(() => {
  for (const [k, v] of [
    ['POS_TICKET_SYNC_ENABLED', saved.enabled],
    ['POS_TICKET_SYNC_TENANTS', saved.tenants],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return isBookingError(e) ? e.code : String(e);
  }
}

describe('POST /settle and the till (B7)', () => {
  it('settles as before while the till is off', async () => {
    const { settle, repo } = setup({ tenantId: TENANT, posTicketId: null });
    expect(await refusal(settle())).toBeNull();
    expect(repo.transition).toHaveBeenCalled();
  });

  it('is gone (410 SETTLED_BY_POS) for a tenant on the till', async () => {
    process.env.POS_TICKET_SYNC_ENABLED = 'true';
    process.env.POS_TICKET_SYNC_TENANTS = TENANT;
    const { settle, repo } = setup({ tenantId: TENANT, posTicketId: null });
    expect(await refusal(settle())).toBe('SETTLED_BY_POS');
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('stays open for a tenant outside the allow-list', async () => {
    process.env.POS_TICKET_SYNC_ENABLED = 'true';
    process.env.POS_TICKET_SYNC_TENANTS = 'someone-else';
    const { settle } = setup({ tenantId: TENANT, posTicketId: null });
    expect(await refusal(settle())).toBeNull();
  });

  it('is gone for any visit that already has a till ticket', async () => {
    const { settle } = setup({
      tenantId: TENANT,
      posTicketId: '0190f0c1-0000-7000-8000-0000000000aa',
    });
    expect(await refusal(settle())).toBe('SETTLED_BY_POS');
  });
});
