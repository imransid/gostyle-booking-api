import { describe, expect, it } from 'vitest';
import type { Service } from '@domain/availability/feasible';
import { FixtureBookingContext } from '../fixtures/fixture-booking-context';
import { DbBookingContext } from './db-booking-context';

const REAL_BRANCH = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';
const SPIKE = '7a7fafa5-bc8d-485e-b1ef-15a8f1634906';

const platformService = (id: string, name: string): Service => ({
  id,
  name,
  durationMin: 30,
  priceFils: 50000,
  currency: 'BDT',
  source: 'platform',
  skill: '',
  requiredLevel: 0,
  resourceType: 'styling',
  claims: { preMin: 0, postMin: 0 },
});

function make(
  opts: { switchOn: boolean; answer?: () => Promise<Service[]> } = {
    switchOn: true,
  },
) {
  const asked: string[] = [];
  const platform = {
    enabled: () => opts.switchOn,
    catalogue: (branchId: string) => {
      asked.push(branchId);
      return (
        opts.answer ??
        (() => Promise.resolve([platformService(SPIKE, 'Spike Hair Cut')]))
      )();
    },
  };
  const context = new DbBookingContext(
    new FixtureBookingContext(),
    {} as never,
    platform as never,
    {} as never,
  );
  return { context, asked };
}

const DEMO_IDS = ['haircut-finish', 'keratin', 'balayage', 'gel-manicure'];

describe('DbBookingContext.loadMenu', () => {
  it('a real branch lists the platform menu and none of the demo services', async () => {
    const { context, asked } = make();
    const menu = await context.loadMenu(REAL_BRANCH);
    expect(menu.map((s) => s.id)).toEqual([SPIKE]);
    expect(asked).toEqual([REAL_BRANCH]);
  });

  it('a real branch whose platform menu is empty lists nothing', async () => {
    const { context } = make({
      switchOn: true,
      answer: () => Promise.resolve([]),
    });
    expect(await context.loadMenu(REAL_BRANCH)).toEqual([]);
  });

  it('a real branch lists nothing with the switch off, and asks no one', async () => {
    const { context, asked } = make({ switchOn: false });
    expect(await context.loadMenu(REAL_BRANCH)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('the demo salon still lists the demo menu, switch on or off', async () => {
    for (const switchOn of [true, false]) {
      const { context, asked } = make({ switchOn });
      const ids = (await context.loadMenu('marina-walk')).map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining(DEMO_IDS));
      expect(asked).toEqual([]);
    }
  });

  it('a platform failure is the failure, not the demo menu', async () => {
    const { context } = make({
      switchOn: true,
      answer: () => Promise.reject(new Error('platform down')),
    });
    await expect(context.loadMenu(REAL_BRANCH)).rejects.toThrow(
      'platform down',
    );
  });
});

describe('DbBookingContext.loadCatalogue', () => {
  it('still carries the demo services, so a stored slug reads back as a name', async () => {
    const { context } = make();
    const ids = (await context.loadCatalogue(REAL_BRANCH)).map((s) => s.id);
    expect(ids[0]).toBe(SPIKE);
    expect(ids).toEqual(expect.arrayContaining(DEMO_IDS));
  });
});
