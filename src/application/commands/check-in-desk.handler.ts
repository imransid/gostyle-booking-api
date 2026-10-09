import { Inject, Injectable, Logger } from '@nestjs/common';
import { shout, type Shouted } from '@application/contract/wire';
import { bookingError } from '@application/contract/errors';
import type { ActorKind, BookingStatus } from '@domain/booking/lifecycle';
import type { ScopedBooking } from '@domain/booking/booking-scope';
import { rejectionReason } from '@domain/booking/check-in-request';
import {
  CheckInRequestRepository,
  type CheckInRequestRow,
  type NothingToAnswer,
  type ReceptionRow,
} from '@infrastructure/persistence/check-in-request.repository';
import {
  CUSTOMER_CONTACT,
  type ContactLookup,
  type CustomerContactReader,
} from '@application/ports/customer-contact.port';
import { LifecycleHandler, type LifecycleView } from './lifecycle.handler';
import { viewOf, type CheckInRequestView } from './check-in-request.handler';

/**
 * A check-in request as the DESK sees it: the customer's view, plus who
 * answered and the reason. The reason is the desk's own words, so it is
 * shown here and never on the customer's side.
 */
export interface DeskRequestView extends CheckInRequestView {
  readonly decidedByKind: Shouted<ActorKind> | null;
  readonly decidedById: string | null;
  readonly reason: string | null;
}

/** One line of the reception list. */
export interface ReceptionItem {
  readonly request: DeskRequestView;
  readonly booking: {
    readonly bookingId: string;
    readonly code: string;
    readonly status: Shouted<BookingStatus>;
    readonly startAt: string;
    readonly endAt: string;
    readonly customerId: string;
    /**
     * As customer-api holds it (ConsumerDirectory, the reminders' lookup).
     * Null when customer-api has none, or did not answer in time: the list
     * never waits for a name (RECEPTION_NAMES_CAP_MS).
     */
    readonly customerName: string | null;
  };
}

/**
 * THE LIST NEVER WAITS ON A NAME. Every name lookup together gets this long;
 * after it, the list goes out with whatever names came back and null for
 * the rest. A desk that cannot see the list is worse than one reading
 * booking codes.
 */
export const RECEPTION_NAMES_CAP_MS = 1_000;

/**
 * Each lookup's own limit, inside the cap, so a slow customer-api answers
 * "unavailable" (and is counted in the one log line) a little before the
 * cap itself fires.
 */
export const RECEPTION_NAME_LOOKUP_MS = 900;

/**
 * A reception line with what the scope check needs to know about its
 * booking. The controller keeps the lines the caller may see (BookingScope
 * .keepInScope) and sends only `item`: the booking's tenant is not shown.
 */
export interface ReceptionEntry {
  readonly item: ReceptionItem;
  readonly scope: ScopedBooking;
}

export function deskViewOf(row: CheckInRequestRow): DeskRequestView {
  return {
    ...viewOf(row),
    decidedByKind: row.decidedByKind === null ? null : shout(row.decidedByKind),
    decidedById: row.decidedById,
    reason: row.reason,
  };
}

/**
 * Self check-in for the desk: approve, reject, and the reception list.
 *
 * Whose booking it is has been asked before this runs (the controller's
 * scope check, always on).
 */
@Injectable()
export class CheckInDeskHandler {
  private static readonly log = new Logger('CheckInReception');

  constructor(
    private readonly requests: CheckInRequestRepository,
    private readonly lifecycle: LifecycleHandler,
    @Inject(CUSTOMER_CONTACT) private readonly contacts: CustomerContactReader,
  ) {}

  /**
   * Yes. THE EXISTING CHECK-IN FIRST, the one POST /v1/bookings/:id/check-in
   * runs (its timing gate, the state machine, the history row and the outbox
   * event, all unchanged), and only then the request is marked approved.
   * Anything the check-in refuses is the answer, and the request still waits.
   */
  async approve(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
  }): Promise<{ request: DeskRequestView; checkIn: LifecycleView }> {
    const out = await this.requests.approveWith(
      {
        bookingId: cmd.bookingId,
        deciderKind: cmd.actor,
        deciderId: cmd.actorId,
      },
      () =>
        this.lifecycle.execute({
          bookingId: cmd.bookingId,
          to: 'checked_in',
          actor: cmd.actor,
          actorId: cmd.actorId,
        }),
    );
    if (out.kind === 'chair_occupied') {
      // The desk's own words, so the occupant's code is fine here: it is the
      // one thing that lets them sort it out.
      throw bookingError(
        'BOOKING_CHAIR_REFUSED',
        `Chair ${out.chairNumber} is taken: ${out.occupant} is checked in ` +
          'there. If that visit is over, finish it and approve again; ' +
          'otherwise the customer needs another chair.',
        {
          reason: 'CHAIR_OCCUPIED',
          chairNumber: out.chairNumber,
          occupant: out.occupant,
        },
      );
    }
    if (out.kind !== 'approved') refuse(out);
    return { request: deskViewOf(out.request), checkIn: out.checkIn };
  }

  /**
   * No, with a reason. The booking is untouched and goes back to the
   * ordinary rules, the auto no-show sweeper included; the customer may not
   * raise again (BOOKING_CHECKIN_REJECTED on their side).
   */
  async reject(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
    readonly reason: string | undefined;
  }): Promise<{ request: DeskRequestView }> {
    const reason = rejectionReason(cmd.reason);
    if (reason === null) {
      // lifecycle.ts's own words for a move that needs a reason.
      throw bookingError('BOOKING_REASON_REQUIRED', 'Choose a reason');
    }
    const out = await this.requests.reject({
      bookingId: cmd.bookingId,
      deciderKind: cmd.actor,
      deciderId: cmd.actorId,
      reason,
    });
    if (out.kind !== 'rejected') refuse(out);
    return { request: deskViewOf(out.request) };
  }

  /**
   * The customer's name on every line of a page the caller may see.
   *
   * Called AFTER the scope check, so only the lines on the page are named,
   * and each customer is asked for once however many lines they have.
   * ConsumerDirectory.GetConsumerContact, the reminders' own lookup, in
   * quick mode: one attempt each, all at once, no retries. Only the name is
   * kept; the email and preferences it also returns are not.
   *
   * NEVER WAITS: RECEPTION_NAMES_CAP_MS for all of them together, then the
   * page goes out with null for whatever had not come back. At most ONE log
   * line per page, however many lookups failed.
   */
  async named(page: {
    readonly waiting: readonly ReceptionItem[];
    readonly needsDecision: readonly ReceptionItem[];
  }): Promise<{ waiting: ReceptionItem[]; needsDecision: ReceptionItem[] }> {
    const ids = [
      ...new Set(
        [...page.waiting, ...page.needsDecision].map(
          (i) => i.booking.customerId,
        ),
      ),
    ];
    const names = await this.namesOf(ids);
    const name = (i: ReceptionItem): ReceptionItem => ({
      ...i,
      booking: {
        ...i.booking,
        customerName: names.get(i.booking.customerId) ?? null,
      },
    });
    return {
      waiting: page.waiting.map(name),
      needsDecision: page.needsDecision.map(name),
    };
  }

  private async namesOf(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    if (ids.length === 0) return new Map();

    const all = Promise.all(
      ids.map((id) =>
        this.contacts
          .lookup(id, { quickMs: RECEPTION_NAME_LOOKUP_MS })
          .catch((e: unknown): ContactLookup => ({
            kind: 'unavailable',
            error: e instanceof Error ? e.message : String(e),
          }))
          .then((out) => [id, out] as const),
      ),
    );
    const answers = await withinCap(all, RECEPTION_NAMES_CAP_MS);

    if (answers === null) {
      CheckInDeskHandler.log.warn(
        `names: customer-api did not answer ${ids.length} lookup(s) within ` +
          `${RECEPTION_NAMES_CAP_MS}ms; the list went out without them`,
      );
      return new Map();
    }

    const names = new Map<string, string | null>();
    let unavailable = 0;
    let firstError = '';
    for (const [id, out] of answers) {
      if (out.kind === 'found') names.set(id, out.contact.fullName);
      if (out.kind === 'unavailable') {
        unavailable += 1;
        if (firstError === '') firstError = out.error;
      }
    }
    if (unavailable > 0) {
      CheckInDeskHandler.log.warn(
        `names: customer-api unavailable for ${unavailable} of ` +
          `${ids.length} customer(s) (${firstError}); those names are null`,
      );
    }
    return names;
  }

  /** The branch's reception list, both halves, before the scope check. */
  async reception(
    branchId: string,
  ): Promise<{ waiting: ReceptionEntry[]; needsDecision: ReceptionEntry[] }> {
    const list = await this.requests.listForBranch(branchId, Date.now());
    return {
      waiting: list.waiting.map(entryOf),
      needsDecision: list.needsDecision.map(entryOf),
    };
  }
}

function refuse(out: NothingToAnswer): never {
  if (out.kind === 'not_found') {
    throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
  }
  throw bookingError(
    'BOOKING_STATE_INVALID',
    'No check-in request is waiting on this booking.',
    { request: out.latest === null ? null : shout(out.latest) },
  );
}

function entryOf(row: ReceptionRow): ReceptionEntry {
  return {
    item: {
      request: deskViewOf(row.request),
      booking: {
        bookingId: row.booking.id,
        code: row.booking.code,
        status: shout(row.booking.status),
        startAt: row.booking.startAt.toISOString(),
        endAt: row.booking.endAt.toISOString(),
        customerId: row.booking.customerId,
        // Filled in by named(), after the scope check.
        customerName: null,
      },
    },
    scope: {
      customerId: row.booking.customerId,
      tenantId: row.booking.tenantId,
      branchId: row.booking.branchId,
    },
  };
}

/** The work's answer, or null if `ms` passed first. Never rejects for time. */
async function withinCap<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
  }
}
