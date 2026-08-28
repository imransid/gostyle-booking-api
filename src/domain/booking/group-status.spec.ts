import { describe, it, expect } from 'vitest';
import { deriveGroupStatus, type ParticipantStatus } from './group-status';

const d = (...s: ParticipantStatus[]) => deriveGroupStatus(s);

describe('confirmed when all active participants are confirmed', () => {
  it('three confirmed', () => {
    expect(d('confirmed', 'confirmed', 'confirmed').status).toBe('confirmed');
  });

  it('confirmed and settled still counts as confirmed', () => {
    expect(d('confirmed', 'settled').status).toBe('confirmed');
  });

  it('A CANCELLED PARTICIPANT DOES NOT HOLD THE PARTY BACK', () => {
    // Two confirmed, one gone. The party is confirmed: the person who left
    // is not "unconfirmed", they are not in the party.
    expect(d('confirmed', 'confirmed', 'cancelled').status).toBe('confirmed');
  });

  it('and the count reflects who is left', () => {
    const out = d('confirmed', 'confirmed', 'cancelled');
    expect(out.activeCount).toBe(2);
    expect(out.explanation).toContain('1 participant has left');
  });
});

describe('partially confirmed while shares are pending', () => {
  it('one paid, one waiting', () => {
    expect(d('confirmed', 'pending_payment').status).toBe(
      'partially_confirmed',
    );
  });

  it('everyone still waiting on a link', () => {
    expect(d('pending_payment', 'pending_payment').status).toBe(
      'partially_confirmed',
    );
  });

  it('and it says so', () => {
    expect(d('confirmed', 'pending_payment').explanation).toContain(
      'Waiting on',
    );
  });
});

describe('in service while ANY participant is in service', () => {
  it('one in the chair, one still to arrive', () => {
    expect(d('in_service', 'confirmed').status).toBe('in_service');
  });

  it('checked in counts too: they are in the building', () => {
    expect(d('checked_in', 'confirmed').status).toBe('in_service');
  });

  it('THE SALON IS WORKING ON THIS GROUP, whatever the others do', () => {
    expect(d('in_service', 'pending_payment').status).toBe('in_service');
    expect(d('in_service', 'cancelled').status).toBe('in_service');
    expect(d('completed', 'in_service').status).toBe('in_service');
  });
});

describe('completed when all are terminal AND at least one completed', () => {
  it('everyone finished', () => {
    expect(d('completed', 'completed').status).toBe('completed');
  });

  it('settled counts as completed', () => {
    expect(d('settled', 'settled').status).toBe('completed');
  });

  it('one completed, one no-showed', () => {
    expect(d('completed', 'no_show').status).toBe('completed');
  });

  it('EVERYONE CANCELLING IS NOT COMPLETED, IT IS CANCELLED', () => {
    // The difference matters to every report that counts visits.
    expect(d('cancelled', 'cancelled').status).toBe('cancelled');
    expect(d('no_show', 'no_show').status).toBe('cancelled');
    expect(d('cancelled', 'no_show', 'expired').status).toBe('cancelled');
  });

  it('an empty party is cancelled, not completed', () => {
    expect(deriveGroupStatus([]).status).toBe('cancelled');
  });
});

describe('DROPPING BELOW TWO', () => {
  it('one confirmed participant left should convert', () => {
    const out = d('confirmed', 'cancelled', 'cancelled');
    expect(out.activeCount).toBe(1);
    expect(out.shouldConvertToSingle).toBe(true);
  });

  it('two is still a party', () => {
    expect(d('confirmed', 'confirmed', 'cancelled').shouldConvertToSingle).toBe(
      false,
    );
  });

  it('a party already in service is NOT converted', () => {
    // History is not rewritten. Converting mid-visit would rewrite what the
    // salon is already doing.
    expect(d('in_service', 'cancelled').shouldConvertToSingle).toBe(false);
  });

  it('nor is a finished one', () => {
    expect(d('completed', 'cancelled').shouldConvertToSingle).toBe(false);
  });

  it('nor an empty one: there is nothing to convert to', () => {
    expect(d('cancelled', 'cancelled').shouldConvertToSingle).toBe(false);
    expect(deriveGroupStatus([]).shouldConvertToSingle).toBe(false);
  });

  it('a lone pending participant converts too', () => {
    expect(d('pending_payment', 'cancelled').shouldConvertToSingle).toBe(true);
  });
});

describe('invariants', () => {
  const all: ParticipantStatus[] = [
    'draft',
    'held',
    'pending_payment',
    'pending_confirmation',
    'confirmed',
    'checked_in',
    'in_service',
    'completed',
    'settled',
    'cancelled',
    'no_show',
    'expired',
    'skipped',
  ];

  it('every combination derives a status, never a crash', () => {
    for (const a of all)
      for (const b of all) {
        const out = d(a, b);
        expect(out.status).toBeTruthy();
        expect(out.explanation.length).toBeGreaterThan(5);
      }
  });

  it('activeCount never exceeds the party size', () => {
    for (const a of all)
      for (const b of all) {
        expect(d(a, b).activeCount).toBeLessThanOrEqual(2);
      }
  });

  it('conversion is only ever suggested for exactly one active participant', () => {
    for (const a of all)
      for (const b of all)
        for (const c of all) {
          const out = d(a, b, c);
          if (out.shouldConvertToSingle) expect(out.activeCount).toBe(1);
        }
  });

  it('a party with anyone in service is always in_service', () => {
    for (const other of all) {
      expect(d('in_service', other).status).toBe('in_service');
    }
  });
});
