import { describe, expect, it } from 'vitest';
import { clockFor, mayActOn } from './customer-ownership';

const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';

describe('mayActOn', () => {
  it('a customer may act on their own booking', () => {
    expect(
      mayActOn({ actorKind: 'customer', actorId: ME, bookingCustomerId: ME }),
    ).toBe(true);
  });

  it("a customer may NOT act on someone else's", () => {
    expect(
      mayActOn({ actorKind: 'customer', actorId: ME, bookingCustomerId: YOU }),
    ).toBe(false);
  });

  it('a customer may not act on a booking that does not exist', () => {
    expect(
      mayActOn({ actorKind: 'customer', actorId: ME, bookingCustomerId: null }),
    ).toBe(false);
  });

  it.each(['staff', 'manager', 'system'])(
    '%s is unchanged: any booking',
    (kind) => {
      expect(
        mayActOn({ actorKind: kind, actorId: ME, bookingCustomerId: YOU }),
      ).toBe(true);
      expect(
        mayActOn({ actorKind: kind, actorId: ME, bookingCustomerId: null }),
      ).toBe(true);
    },
  );
});

describe('clockFor', () => {
  it("drops a customer's clock", () => {
    expect(clockFor('customer', 1_000)).toBeUndefined();
  });

  it.each(['staff', 'manager', 'system'])(
    'keeps the %s clock, as before',
    (kind) => {
      expect(clockFor(kind, 1_000)).toBe(1_000);
      expect(clockFor(kind, undefined)).toBeUndefined();
    },
  );
});
