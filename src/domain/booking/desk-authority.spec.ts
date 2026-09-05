import { describe, it, expect } from 'vitest';
import { ANY_STAFF, mayWorkTheDesk, deskRefusal } from './desk-authority';
import type { ActorKind } from './lifecycle';

const EVERY_KIND: readonly ActorKind[] = [
  'customer',
  'staff',
  'manager',
  'system',
];

describe('who may work the desk', () => {
  it('lets the salon through', () => {
    expect(mayWorkTheDesk('staff')).toBe(true);
    expect(mayWorkTheDesk('manager')).toBe(true);
  });

  it('lets the system through, because the sweepers are the salon too', () => {
    expect(mayWorkTheDesk('system')).toBe(true);
  });

  it('refuses a customer', () => {
    // The whole point. A walk-in is somebody standing at the desk; a
    // customer reaching this endpoint remotely wants the booking flow.
    expect(mayWorkTheDesk('customer')).toBe(false);
  });

  it('refuses exactly one kind, so a new kind is not silently admitted', () => {
    // Written as a count rather than a list of positives: if a fifth kind is
    // added and this predicate is not revisited, the assertion that fails is
    // this one, before the endpoint is opened to it by accident.
    const allowed = EVERY_KIND.filter(mayWorkTheDesk);
    expect(allowed).toEqual(['staff', 'manager', 'system']);
  });
});

describe('the refusal', () => {
  it('names the actor and the act', () => {
    expect(deskRefusal('customer')).toBe(
      'A customer may not work the salon desk.',
    );
  });
});

describe('the shared staff list', () => {
  it('is the two kinds the lifecycle table also means by staff', () => {
    expect([...ANY_STAFF]).toEqual(['staff', 'manager']);
  });

  it('agrees with the predicate, which is why there is one list', () => {
    for (const kind of ANY_STAFF) expect(mayWorkTheDesk(kind)).toBe(true);
  });
});
