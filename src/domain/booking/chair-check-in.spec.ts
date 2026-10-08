import { describe, expect, it } from 'vitest';
import {
  chairCheckInVerdict,
  customerSentence,
  type ChairRefusalReason,
  type ClaimingBooking,
  type ScannedChair,
} from './chair-check-in';

const LOOK_CHANGE = 'f2a9882b-c822-4107-b650-29af2e303c24';
const ROMONI = '3c457f1c-e7d4-4c9b-b877-27146c834608';
const BRANCH_A = 'b7e92439-8285-469a-bba4-dcaa3dd5842c';
const BRANCH_B = 'b67fad90-6064-446a-8d80-411347c1f929';
const CHAIR = '0192a3b4-0000-7000-8000-000000000007';

const chair = (over: Partial<ScannedChair> = {}): ScannedChair => ({
  cardStatus: 'LIVE',
  chairId: CHAIR,
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  chairNumber: '7',
  zoneName: 'Window section',
  chairState: 'ACTIVE',
  chairBookable: true,
  ...over,
});

const booking = (over: Partial<ClaimingBooking> = {}): ClaimingBooking => ({
  tenantId: LOOK_CHANGE,
  branchId: BRANCH_A,
  ...over,
});

function verdict(
  over: {
    chair?: Partial<ScannedChair>;
    booking?: Partial<ClaimingBooking>;
    occupant?: string | null;
  } = {},
) {
  return chairCheckInVerdict({
    chair: chair(over.chair),
    booking: booking(over.booking),
    occupant: over.occupant ?? null,
  });
}

/** Platform's chair states today, and one it might add tomorrow. */
const PLATFORM_STATES = [
  'DRAFT',
  'PENDING',
  'SETUP',
  'ACTIVE',
  'FROZEN',
  'MAINTENANCE',
  'RETIRED',
  'QUARANTINED',
];

describe('chairCheckInVerdict: may this booking claim the scanned chair', () => {
  it('accepts a live card on a free, bookable chair in the booking’s salon', () => {
    expect(verdict()).toEqual({
      kind: 'accept',
      chair: { chairId: CHAIR, chairNumber: '7', zoneName: 'Window section' },
    });
  });

  it('keeps a chair with no zone, zone null', () => {
    expect(verdict({ chair: { zoneName: null } })).toEqual({
      kind: 'accept',
      chair: { chairId: CHAIR, chairNumber: '7', zoneName: null },
    });
  });

  describe('1. the card: LIVE only, for v1', () => {
    it.each(['REPLACED', 'INACTIVE', 'RETIRED'])(
      'refuses a %s card, carrying platform’s word for the log',
      (cardStatus) => {
        expect(verdict({ chair: { cardStatus } })).toEqual({
          kind: 'refused',
          why: 'card_out_of_date',
          cardStatus,
        });
      },
    );

    it.each(['', 'live', 'SUSPENDED'])(
      'refuses anything that is not exactly LIVE (%j): fails closed',
      (cardStatus) => {
        expect(verdict({ chair: { cardStatus } })).toMatchObject({
          why: 'card_out_of_date',
        });
      },
    );

    it('is asked first: a replaced card in another salon, on a frozen chair', () => {
      expect(
        verdict({
          chair: {
            cardStatus: 'REPLACED',
            tenantId: ROMONI,
            chairBookable: false,
          },
        }),
      ).toMatchObject({ why: 'card_out_of_date' });
    });
  });

  describe('2. the salon: the booking’s own tenant and branch', () => {
    it('refuses a booking with no tenant, and names it as a data fault', () => {
      for (const tenantId of [null, '', '   ']) {
        expect(verdict({ booking: { tenantId } })).toEqual({
          kind: 'refused',
          why: 'other_salon',
          which: 'untenanted_booking',
        });
      }
    });

    it('refuses a chair of another tenant', () => {
      expect(verdict({ chair: { tenantId: ROMONI } })).toEqual({
        kind: 'refused',
        why: 'other_salon',
        which: 'other_tenant',
      });
    });

    it('refuses a chair with no tenant: absent never matches', () => {
      expect(verdict({ chair: { tenantId: null } })).toMatchObject({
        which: 'other_tenant',
      });
    });

    it('refuses a chair in another branch of the same tenant', () => {
      expect(verdict({ chair: { branchId: BRANCH_B } })).toEqual({
        kind: 'refused',
        why: 'other_salon',
        which: 'other_branch',
      });
    });

    it('refuses a deleted chair, which has no branch', () => {
      expect(verdict({ chair: { branchId: null } })).toMatchObject({
        which: 'other_branch',
      });
    });

    it('never refuses a spelling: case and spaces are not another salon', () => {
      expect(
        verdict({
          chair: {
            tenantId: ` ${LOOK_CHANGE.toUpperCase()} `,
            branchId: BRANCH_A.toUpperCase(),
          },
        }),
      ).toMatchObject({ kind: 'accept' });
    });

    it('is asked before the chair: another branch, on a chair not bookable', () => {
      expect(
        verdict({ chair: { branchId: BRANCH_B, chairBookable: false } }),
      ).toMatchObject({ why: 'other_salon' });
    });
  });

  describe('3. the chair: decided on chair_bookable alone', () => {
    it('refuses when platform says not bookable, carrying its state for the desk', () => {
      expect(
        verdict({ chair: { chairBookable: false, chairState: 'FROZEN' } }),
      ).toEqual({
        kind: 'refused',
        why: 'chair_not_bookable',
        chairState: 'FROZEN',
      });
    });

    it('carries a null state when platform sent none', () => {
      expect(
        verdict({ chair: { chairBookable: false, chairState: null } }),
      ).toEqual({
        kind: 'refused',
        why: 'chair_not_bookable',
        chairState: null,
      });
    });

    // The point of the rule. No state list lives here: whatever platform
    // says about bookability, for whatever state, is the answer.
    it.each(PLATFORM_STATES)(
      'follows chair_bookable whatever the state says (%s)',
      (chairState) => {
        expect(
          verdict({ chair: { chairState, chairBookable: true } }),
        ).toMatchObject({ kind: 'accept' });
        expect(
          verdict({ chair: { chairState, chairBookable: false } }),
        ).toMatchObject({ why: 'chair_not_bookable', chairState });
      },
    );

    it('refuses a live, bookable chair with no number: the desk could not be told which', () => {
      for (const chairNumber of [null, '', '  ']) {
        expect(verdict({ chair: { chairNumber } })).toMatchObject({
          why: 'chair_not_bookable',
        });
      }
    });

    it('stores the number trimmed', () => {
      expect(verdict({ chair: { chairNumber: ' 7 ' } })).toMatchObject({
        chair: { chairNumber: '7' },
      });
    });
  });

  describe('4. occupied: another booking checked in with this chair', () => {
    it('refuses, naming the occupant for the desk', () => {
      expect(verdict({ occupant: 'GS-1402' })).toEqual({
        kind: 'refused',
        why: 'chair_occupied',
        occupant: 'GS-1402',
      });
    });

    it('is asked after bookable: a frozen chair is not available either way', () => {
      expect(
        verdict({ chair: { chairBookable: false }, occupant: 'GS-1402' }),
      ).toMatchObject({ why: 'chair_not_bookable' });
    });
  });
});

describe('customerSentence: what the app may show', () => {
  const REASONS: ChairRefusalReason[] = [
    'card_out_of_date',
    'other_salon',
    'chair_not_bookable',
    'chair_occupied',
  ];

  it('has a sentence for every reason', () => {
    for (const why of REASONS) expect(customerSentence(why)).not.toBe('');
  });

  it('says the card is out of date, and sends them to the desk', () => {
    expect(customerSentence('card_out_of_date')).toBe(
      'This card is out of date. Please see the desk.',
    );
  });

  it('gives not bookable and occupied one sentence: take another, or the desk', () => {
    const sentence =
      'That chair is not available. Please take another or see the desk.';
    expect(customerSentence('chair_not_bookable')).toBe(sentence);
    expect(customerSentence('chair_occupied')).toBe(sentence);
  });

  // Platform's vocabulary is for the log and the desk. Asked through the
  // verdict, as the handler will: for every state, today's and tomorrow's,
  // the customer reads the same sentence and never the state's name.
  it.each(PLATFORM_STATES)(
    'never shows platform’s word for the chair (%s)',
    (chairState) => {
      const v = verdict({ chair: { chairState, chairBookable: false } });
      if (v.kind !== 'refused') throw new Error('expected a refusal');
      const shown = customerSentence(v.why);
      expect(shown).toBe(customerSentence('chair_not_bookable'));
      expect(shown.toUpperCase()).not.toContain(chairState);
    },
  );

  it('never shows another customer’s booking', () => {
    const v = verdict({ occupant: 'GS-1402' });
    if (v.kind !== 'refused') throw new Error('expected a refusal');
    expect(customerSentence(v.why)).not.toContain('GS-1402');
  });
});
