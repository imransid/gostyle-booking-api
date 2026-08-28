import { describe, it, expect } from 'vitest';
import {
  BookingStatus,
  PaymentStatus,
  WaitlistStatus,
  WalkInStatus,
  SeriesStatus,
  OccurrenceState,
  WorklistItemState,
  GroupMode,
  GroupArrangement,
} from '../../generated/prisma/enums';
import {
  shout,
  unshout,
  modeToWire,
  modeFromWire,
  arrangementToWire,
  arrangementFromWire,
  WIRE_GROUP_MODES,
  WIRE_ARRANGEMENTS,
  MINOR_UNITS_PER_MAJOR,
} from './wire';

/**
 * The unions the schema actually holds, not a copy of them.
 *
 * Importing the generated enums means adding a status to schema.prisma adds
 * it to this test for free. A hand-written list here would pass forever while
 * the fifteenth booking status went out lowercase.
 */
const STATUS_ENUMS = {
  BookingStatus,
  PaymentStatus,
  WaitlistStatus,
  WalkInStatus,
  SeriesStatus,
  OccurrenceState,
  WorklistItemState,
};

describe('the status dialect', () => {
  for (const [name, members] of Object.entries(STATUS_ENUMS)) {
    const values = Object.values(members) as string[];

    it(`shouts every ${name} and never returns an empty string`, () => {
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(shout(v)).toBe(v.toUpperCase());
        expect(shout(v)).not.toBe('');
      }
    });

    it(`round-trips every ${name}`, () => {
      for (const v of values) {
        expect(unshout(shout(v), values)).toBe(v);
      }
    });

    it(`keeps every ${name} distinct once shouted`, () => {
      // Two statuses that collide when uppercased would make the wire
      // ambiguous in one direction and silently wrong in the other.
      expect(new Set(values.map((v) => shout(v))).size).toBe(values.length);
    });
  }

  it('refuses a status that is not in the union', () => {
    expect(unshout('CONFIRMED', ['confirmed'])).toBe('confirmed');
    expect(unshout('DROP TABLE', ['confirmed'])).toBeNull();
    expect(unshout('', ['confirmed'])).toBeNull();
  });

  it('underscores survive the shout, so pending_payment stays two words', () => {
    expect(shout('pending_payment')).toBe('PENDING_PAYMENT');
    expect(shout('no_show')).toBe('NO_SHOW');
    expect(shout('partially_confirmed')).toBe('PARTIALLY_CONFIRMED');
  });
});

describe('the group mode', () => {
  it('covers every mode the schema has', () => {
    const schemaModes = Object.values(GroupMode) as string[];
    expect(schemaModes.sort()).toEqual(
      ['arrive_together', 'finish_together'].sort(),
    );
  });

  it('renames rather than shouts', () => {
    expect(modeToWire('arrive_together')).toBe('TOGETHER');
    expect(modeToWire('finish_together')).toBe('FINISH');
    // The point of the table: FINISH is not FINISH_TOGETHER.
    expect(modeToWire('finish_together')).not.toBe(shout('finish_together'));
  });

  it('round-trips both directions', () => {
    for (const m of Object.values(GroupMode)) {
      expect(modeFromWire(modeToWire(m))).toBe(m);
    }
    for (const w of WIRE_GROUP_MODES) {
      expect(modeToWire(modeFromWire(w))).toBe(w);
    }
  });
});

describe('who pays', () => {
  it('covers every arrangement the schema has', () => {
    expect((Object.values(GroupArrangement) as string[]).sort()).toEqual(
      ['each_pays_own', 'organiser_pays_all', 'split_equally'].sort(),
    );
  });

  it('is the American spelling on the wire and the British one inside', () => {
    expect(arrangementToWire('organiser_pays_all')).toBe('ORGANIZER');
    expect(arrangementFromWire('ORGANIZER')).toBe('organiser_pays_all');
  });

  it('round-trips both directions', () => {
    for (const a of Object.values(GroupArrangement)) {
      expect(arrangementFromWire(arrangementToWire(a))).toBe(a);
    }
    for (const w of WIRE_ARRANGEMENTS) {
      expect(arrangementToWire(arrangementFromWire(w))).toBe(w);
    }
  });
});

describe('money on the wire', () => {
  it('is the same integer under a different name', () => {
    // No conversion happens at this boundary, and that is the whole safety
    // argument for renaming the field rather than mapping it: a minor unit
    // IS a fil, so priceMinor and price_fils are always the same number.
    expect(MINOR_UNITS_PER_MAJOR).toBe(100);
  });
});
