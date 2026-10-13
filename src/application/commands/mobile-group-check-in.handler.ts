import { Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { toUuid } from '@infrastructure/persistence/hold.repository';
import { CheckInRequestRepository } from '@infrastructure/persistence/check-in-request.repository';
import { bookingError, type BookingError } from '@application/contract/errors';
import type { GroupReader } from '@application/queries/mobile-group-read.handler';
import { MobileContractError } from './mobile-booking.error';
import { viewOf, type CheckInRequestView } from './check-in-request.handler';
import { laneOutcome, type LaneOutcome } from './group-check-in-lanes';
import { partyAnswer } from './group-check-in-party';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a lane is, in the words the party read already uses. */
type MemberKind = 'self' | 'registered' | 'guest';

/** One lane of the party, as loaded: its booking and who it is. */
interface PartyLane {
  readonly bookingId: string;
  readonly bookingCode: string;
  readonly memberKind: MemberKind;
}

/** One lane in the answer to "we are here". */
export interface GroupCheckInLane extends PartyLane {
  readonly outcome: LaneOutcome['outcome'];
  /** The single route's own request view; null unless RAISED or WAITING. */
  readonly request: CheckInRequestView | null;
  /** The single route's own error body; null unless REFUSED. */
  readonly error: ReturnType<BookingError['toBody']> | null;
}

export interface GroupCheckInView {
  readonly groupId: string;
  readonly lanes: readonly GroupCheckInLane[];
}

/** One lane in the read: its latest request, or null if it never raised. */
export interface GroupCheckInReadLane extends PartyLane {
  readonly request: CheckInRequestView | null;
}

/**
 * "We are here" for an app party: the SAME single raise, once per lane.
 *
 * ONLY THE BOOKER, the same check as the group cancel: anyone else, a desk
 * party, or no such party is 404, all looking alike from outside.
 *
 * NOT all or nothing, unlike the cancel. Each lane is raised on its own, in
 * its own transaction and its own booking lock (raise), so a friend who is
 * too early does not stop the others. A refusal is data on its lane
 * (laneOutcome), never a throw that stops the loop.
 *
 * ONE CLOCK for the whole party: read once, passed to every lane, so two
 * lanes of the same party can never land on two sides of the window.
 *
 * A failure part way (the database, not a rule) leaves the lanes before it
 * raised. Sending again finishes the job: those lanes answer WAITING.
 */
@Injectable()
export class MobileGroupCheckInHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: CheckInRequestRepository,
  ) {}

  async raise(
    groupId: string,
    who: GroupReader,
    bookingIds?: readonly string[],
    nowMs: number = Date.now(),
  ): Promise<{ readonly status: 201 | 200; readonly view: GroupCheckInView }> {
    const lanes = pick(await this.partyOf(groupId, who), bookingIds);

    const done: { lane: PartyLane; outcome: LaneOutcome }[] = [];
    for (const lane of lanes) {
      const out = await this.requests.raise({
        bookingId: lane.bookingId,
        actor: 'customer',
        actorId: who.actorId,
        nowMs,
      });
      done.push({ lane, outcome: laneOutcome(out) });
    }

    const view: GroupCheckInView = { groupId, lanes: done.map(present) };
    const answer = partyAnswer(done.map((d) => d.outcome));
    switch (answer.kind) {
      case 'created':
        return { status: 201, view };
      case 'waiting':
        return { status: 200, view };
      case 'refused':
        throw answer.error;
      case 'none':
        throw bookingError(
          'BOOKING_GROUP_CHECKIN_NONE',
          'Nothing could be checked in for this party.',
          { groupId, lanes: view.lanes },
        );
    }
  }

  async read(
    groupId: string,
    who: GroupReader,
  ): Promise<{
    readonly groupId: string;
    readonly lanes: GroupCheckInReadLane[];
  }> {
    const lanes = await this.partyOf(groupId, who);
    const out: GroupCheckInReadLane[] = [];
    for (const lane of lanes) {
      const latest = await this.requests.latestFor(lane.bookingId);
      out.push({ ...lane, request: latest === null ? null : viewOf(latest) });
    }
    return { groupId, lanes: out };
  }

  /** The party's lanes, in party order, or 404 for anyone but its booker. */
  private async partyOf(
    groupId: string,
    who: GroupReader,
  ): Promise<PartyLane[]> {
    const group = UUID_RE.test(groupId)
      ? await this.prisma.bookingGroup.findUnique({
          where: { id: groupId },
          select: {
            organiserId: true,
            source: true,
            participants: {
              orderBy: { position: 'asc' },
              select: { bookingId: true, customerId: true },
            },
          },
        })
      : null;
    if (
      group === null ||
      group.source !== 'mobile' ||
      who.actorKind !== 'customer' ||
      group.organiserId !== toUuid(who.actorId)
    ) {
      // 404, never 403: "not yours" and "no such party" look the same.
      throw MobileContractError.notFoundBooking();
    }

    const ids = group.participants
      .map((p) => p.bookingId)
      .filter((x): x is string => x !== null);
    const rows = await this.prisma.booking.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    const codeOf = new Map(rows.map((r) => [r.id, r.code]));

    // Walked in PARTY order (participants), never in findMany's order.
    return group.participants.flatMap((p): PartyLane[] => {
      const code = p.bookingId === null ? undefined : codeOf.get(p.bookingId);
      if (p.bookingId === null || code === undefined) return [];
      return [
        {
          bookingId: p.bookingId,
          bookingCode: code,
          memberKind:
            p.customerId === null
              ? 'guest'
              : p.customerId === group.organiserId
                ? 'self'
                : 'registered',
        },
      ];
    });
  }
}

/**
 * The lanes the booker named (D2), or every lane when none are named. An id
 * that is not a lane of THIS party is refused whole, before anything is
 * raised: half a request on a typo would be worse than none.
 */
function pick(
  lanes: readonly PartyLane[],
  bookingIds: readonly string[] | undefined,
): readonly PartyLane[] {
  if (bookingIds === undefined || bookingIds.length === 0) return lanes;
  const wanted = new Set(bookingIds.map((id) => id.toLowerCase()));
  const known = new Set(lanes.map((l) => l.bookingId.toLowerCase()));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new MobileContractError(
      [
        {
          field: 'bookingIds',
          code: 'not_found',
          message: `Not a booking of this party: ${unknown.join(', ')}`,
        },
      ],
      422,
    );
  }
  return lanes.filter((l) => wanted.has(l.bookingId.toLowerCase()));
}

/** A lane and its outcome, as the app reads it. */
function present(d: {
  lane: PartyLane;
  outcome: LaneOutcome;
}): GroupCheckInLane {
  const o = d.outcome;
  return {
    ...d.lane,
    outcome: o.outcome,
    request:
      o.outcome === 'RAISED' || o.outcome === 'WAITING'
        ? viewOf(o.request)
        : null,
    error: o.outcome === 'REFUSED' ? o.error.toBody() : null,
  };
}
