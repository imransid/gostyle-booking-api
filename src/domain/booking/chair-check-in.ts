import { cleanId } from './booking-scope';

/**
 * SELF CHECK-IN AT A CHAIR: may this customer claim the chair they scanned,
 * for this booking?
 *
 * The customer sits down and scans the QR card on the chair. Platform owns
 * the chairs and answers what the card is and whether the chair may take a
 * booking (gostyle-platform docs/chair-directory-team.md, the source of
 * truth). Platform has no bookings, so whether this booking may have that
 * chair, and whether somebody is already in it, is asked here.
 *
 * An accepted chair is still only a CLAIM (check-in-request.ts): it rides
 * on the check-in request, and the desk approves as before.
 *
 * In this order, each the most useful answer to give first:
 *
 *   1. card out of date   anything but a LIVE card: one the salon replaced
 *                         or withdrew, or a chair that has left the salon.
 *                         LIVE only, for v1.
 *   2. other salon        the chair is not in the booking's own tenant and
 *                         branch. Before the chair's own answers: "take
 *                         another" is no advice in the wrong salon.
 *   3. not bookable       platform's chair_bookable is false. DECIDED ON
 *                         THAT ALONE, never on the chair's state: the rule
 *                         for which states may take a booking is platform's,
 *                         and a copy of it here would quietly disagree the
 *                         day platform changes it.
 *   4. occupied           another booking is checked in or in service with
 *                         this chair. Only those: a WAITING claim on the
 *                         same chair does not block it, because a claim can
 *                         be stale and blocking would hold a free chair until
 *                         the desk answers. Approving asks again, under a
 *                         lock, and that is the moment that matters.
 *
 * PLATFORM'S WORDS NEVER REACH THE CUSTOMER. The card status and the chair
 * state are platform's vocabulary (FROZEN, MAINTENANCE, SETUP...). A refusal
 * carries them for the log and the desk; what the customer is told is
 * customerSentence, which is chosen by the reason alone. An app that switched
 * on a state name would show a blank or a raw word the day platform adds one.
 */

/** What platform answered for a scanned card, with '' read as null. */
export interface ScannedChair {
  /** The CARD: LIVE, REPLACED, INACTIVE or RETIRED. Compared, never shown. */
  readonly cardStatus: string;
  readonly chairId: string;
  readonly tenantId: string | null;
  /** Null when the chair row was deleted. */
  readonly branchId: string | null;
  /** Null for a retired chair: its number may be another chair's now. */
  readonly chairNumber: string | null;
  /** What the desk reads, e.g. "Window section". Null: no zone. */
  readonly zoneName: string | null;
  /** The CHAIR, in platform's words. For the log and the desk only. */
  readonly chairState: string | null;
  /** Platform's "may this chair take a booking now". Decided on. */
  readonly chairBookable: boolean;
}

/** The booking the customer is claiming the chair for. */
export interface ClaimingBooking {
  /** Null on a booking nobody stamped with a tenant. */
  readonly tenantId: string | null;
  /** As booking.branch_id holds it. */
  readonly branchId: string;
}

/**
 * What the claim stores. Every call to platform writes a scan row, so the
 * desk can never ask again: the label it reads is kept from the scan.
 */
export interface ClaimedChair {
  readonly chairId: string;
  readonly chairNumber: string;
  readonly zoneName: string | null;
}

export type ChairRefusal =
  | {
      readonly why: 'card_out_of_date';
      /** Platform's word for the card, for the log. */
      readonly cardStatus: string;
    }
  | {
      readonly why: 'other_salon';
      /** Which comparison failed, as booking-scope.ts names them. An
       *  untenanted booking is a data fault, not a customer in the wrong
       *  salon, and the log should say so. */
      readonly which: 'untenanted_booking' | 'other_tenant' | 'other_branch';
    }
  | {
      readonly why: 'chair_not_bookable';
      /** Platform's word for the chair, for the log and the desk. NEVER for
       *  the app: see customerSentence. */
      readonly chairState: string | null;
    }
  | {
      readonly why: 'chair_occupied';
      /** The code of the booking in the chair. The desk's, not the app's. */
      readonly occupant: string;
    };

export type ChairRefusalReason = ChairRefusal['why'];

export type ChairVerdict =
  | { readonly kind: 'accept'; readonly chair: ClaimedChair }
  | ({ readonly kind: 'refused' } & ChairRefusal);

/** The one card status check-in accepts, for v1. */
const LIVE = 'LIVE';

export function chairCheckInVerdict(input: {
  readonly chair: ScannedChair;
  readonly booking: ClaimingBooking;
  /**
   * The code of another booking that is checked in or in service with this
   * chair, or null if there is none. Asked of booking-api's own data: it is
   * what platform cannot know.
   */
  readonly occupant: string | null;
}): ChairVerdict {
  const { chair, booking } = input;

  if (chair.cardStatus !== LIVE) {
    return {
      kind: 'refused',
      why: 'card_out_of_date',
      cardStatus: chair.cardStatus,
    };
  }

  // Tenant first, then branch, compared as booking-scope.ts compares them.
  // A platform branch id is a real uuid, which the booking's column holds as
  // toUuid leaves it, lowercased; so this comparison is the fold, and there
  // is no slug on either side to convert.
  const bookingTenant = cleanId(booking.tenantId);
  if (bookingTenant === null) {
    return { kind: 'refused', why: 'other_salon', which: 'untenanted_booking' };
  }
  if (cleanId(chair.tenantId) !== bookingTenant) {
    return { kind: 'refused', why: 'other_salon', which: 'other_tenant' };
  }
  const bookingBranch = cleanId(booking.branchId);
  if (bookingBranch === null || cleanId(chair.branchId) !== bookingBranch) {
    return { kind: 'refused', why: 'other_salon', which: 'other_branch' };
  }

  // No number on a LIVE card is not something platform sends (only a
  // retired chair loses its number, and its card is not LIVE). If it ever
  // did, the desk could not be told which chair: so not one to seat anybody
  // at.
  const chairNumber = (chair.chairNumber ?? '').trim();
  if (!chair.chairBookable || chairNumber === '') {
    return {
      kind: 'refused',
      why: 'chair_not_bookable',
      chairState: chair.chairState,
    };
  }

  if (input.occupant !== null) {
    return { kind: 'refused', why: 'chair_occupied', occupant: input.occupant };
  }

  return {
    kind: 'accept',
    chair: { chairId: chair.chairId, chairNumber, zoneName: chair.zoneName },
  };
}

/** Not available, for whatever reason of the chair's own. */
const CHAIR_NOT_AVAILABLE =
  'That chair is not available. Please take another or see the desk.';

/**
 * What the customer is told, by the reason ALONE.
 *
 * It takes the reason and nothing else, so neither platform's state names
 * nor another customer's booking can reach the app's screen through it. Not
 * bookable and occupied are one sentence: to the customer both mean "not
 * this chair", and both have the same way out.
 */
export function customerSentence(why: ChairRefusalReason): string {
  switch (why) {
    case 'card_out_of_date':
      return 'This card is out of date. Please see the desk.';
    case 'other_salon':
      return 'This chair is not at the salon of your booking. Please see the desk.';
    case 'chair_not_bookable':
    case 'chair_occupied':
      return CHAIR_NOT_AVAILABLE;
  }
}
