import { describe, it, expect, vi } from 'vitest';
import { PosTicketSyncRepository } from './pos-ticket-sync.repository';
import { toUuid } from './hold.repository';

const BOOKING = '0190f0c1-2222-7000-8000-000000000002';

/** The SQL text of a tagged-template call, placeholders as `?`. */
const sqlOf = (call: unknown[]): string =>
  (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');

describe('PosTicketSyncRepository SQL', () => {
  it('enqueues once per event, against the booking’s own tenant', async () => {
    const prisma = { $executeRaw: vi.fn(() => Promise.resolve(1)) };
    const repo = new PosTicketSyncRepository(prisma as never);
    expect(
      await repo.enqueue(
        {
          eventId: '0190f0c1-eeee-7000-8000-00000000000e',
          eventAt: new Date(),
          bookingId: BOOKING,
          kind: 'open',
          bookingStatus: 'checked_in',
        },
        ['t1'],
      ),
    ).toBe(true);
    const sql = sqlOf(prisma.$executeRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(sql).toContain('b.tenant_id = ANY');
  });

  it('claims only the oldest unfinished row of each booking, skip-locked', async () => {
    const prisma = { $queryRaw: vi.fn(() => Promise.resolve([])) };
    const repo = new PosTicketSyncRepository(prisma as never);
    await repo.claimDue(20, [], 300_000);
    const sql = sqlOf(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("o.status IN ('pending', 'parked')");
    expect(sql).toContain('(o.event_at, o.id) < (p.event_at, p.id)');
    expect(sql).toContain('FOR NO KEY UPDATE OF p SKIP LOCKED');
    expect(sql).toContain('b.tenant_id IS NOT NULL');
  });

  it('never moves a settled booking’s ticket', async () => {
    const prisma = { $executeRaw: vi.fn(() => Promise.resolve(1)) };
    const repo = new PosTicketSyncRepository(prisma as never);
    await repo.setTicket(BOOKING, 'x', '#T-1');
    await repo.clearTicket(BOOKING, 'x');
    for (const call of prisma.$executeRaw.mock.calls) {
      expect(sqlOf(call as unknown[])).toContain("status <> 'settled'");
    }
    expect(sqlOf(prisma.$executeRaw.mock.calls[1] as unknown[])).toContain(
      'AND pos_ticket_id =',
    );
  });
});

describe('PosTicketSyncRepository.bookingFor', () => {
  function withBooking(over: Record<string, unknown>) {
    const prisma = {
      booking: {
        findUnique: vi.fn(() =>
          Promise.resolve({
            id: BOOKING,
            code: 'GS-1',
            tenantId: 't1',
            branchId: 'b1',
            startAt: new Date(),
            status: 'checked_in',
            customerId: 'c1',
            groupId: null,
            netFils: null,
            taxFils: null,
            discountFils: null,
            items: [],
            products: [],
            ledger: [],
            statusHistory: [
              { toStatus: 'checked_in', actorId: 'second-check-in' },
              { toStatus: 'confirmed', actorId: 'undo' },
              { toStatus: 'checked_in', actorId: 'first-check-in' },
            ],
            ...over,
          }),
        ),
      },
    };
    return new PosTicketSyncRepository(prisma as never);
  }

  it('takes the latest move into each status for its actor', async () => {
    const ctx = await withBooking({}).bookingFor(BOOKING);
    expect(ctx?.actorByStatus.get('checked_in')).toBe('second-check-in');
    expect(ctx?.actorByStatus.get('confirmed')).toBe('undo');
  });

  it('knows a guest lane by its folded group id', async () => {
    const group = '0190f0c1-4444-7000-8000-000000000044';
    const ctx = await withBooking({
      groupId: group,
      customerId: toUuid(group),
    }).bookingFor(BOOKING);
    expect(ctx?.booking.isGuest).toBe(true);

    const member = await withBooking({ groupId: group }).bookingFor(BOOKING);
    expect(member?.booking.isGuest).toBe(false);
  });

  it('has nothing to send for a booking with no tenant', async () => {
    expect(
      await withBooking({ tenantId: null }).bookingFor(BOOKING),
    ).toBeNull();
  });
});
