import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { toUuid } from '@infrastructure/persistence/hold.repository';
import { checkTransition } from '@domain/booking/lifecycle';
import { isBookingError } from '@application/contract/errors';
import { LifecycleHandler } from './lifecycle.handler';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import {
  MobileGroupReadHandler,
  type GroupReader,
  type MobileGroupView,
} from '@application/queries/mobile-group-read.handler';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A member who has already left the party: nothing to cancel. */
const GONE: readonly string[] = [
  'cancelled',
  'no_show',
  'expired',
  'skipped',
  'rescheduled',
];

const REASON = 'Cancelled by the booker, with the whole party';

/**
 * POST /v1/mobile-booking/group/:groupId/cancel: the whole party, together.
 *
 * ONLY THE BOOKER (decision D3). Anyone else, staff included, is 404: the
 * desk cancels a party one lane at a time on its own routes, as it always
 * has.
 *
 * EVERY MEMBER IS CANCELLED BY THE SAME CODE A SINGLE CANCEL USES.
 * LifecycleHandler is called once per member and is not changed: the state
 * machine, the money outcome, the chair given back and the event published
 * are exactly what POST /v1/bookings/:id/cancel does for one booking. The
 * status listener then moves the group to `cancelled` from those events.
 *
 * ALL OR NOTHING, as far as the rules can say in advance. Every member is
 * checked against the state machine BEFORE any is cancelled, so a party with
 * one member already checked in is refused whole rather than half cancelled.
 * Each cancel is its own transaction, so a failure part way (the database,
 * not a rule) can leave some members cancelled; sending the request again
 * finishes the job, because members already gone are skipped.
 */
@Injectable()
export class MobileGroupCancelHandler {
  private static readonly log = new Logger(MobileGroupCancelHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleHandler,
    private readonly reads: MobileGroupReadHandler,
  ) {}

  async execute(groupId: string, who: GroupReader): Promise<MobileGroupView> {
    const group = UUID_RE.test(groupId)
      ? await this.prisma.bookingGroup.findUnique({
          where: { id: groupId },
          select: {
            organiserId: true,
            source: true,
            participants: {
              orderBy: { position: 'asc' },
              select: { bookingId: true },
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
    const lanes = await this.prisma.booking.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, status: true },
    });
    const live = lanes.filter((l) => !GONE.includes(l.status));

    for (const lane of live) {
      const verdict = checkTransition({
        from: lane.status,
        to: 'cancelled',
        actor: 'customer',
        reason: REASON,
      });
      if (verdict.kind !== 'allowed') {
        throw cannotCancel(
          `${lane.code} cannot be cancelled from the app: ${verdict.message} ` +
            'Nothing was cancelled. Ask the salon.',
        );
      }
    }

    for (const lane of live) {
      try {
        await this.lifecycle.execute({
          bookingId: lane.id,
          to: 'cancelled',
          actor: 'customer',
          actorId: who.actorId,
          reason: REASON,
          initiatedBy: 'customer',
        });
      } catch (e) {
        MobileGroupCancelHandler.log.warn(
          `group ${groupId}: cancelling ${lane.code} failed; members before ` +
            'it are cancelled, a retry finishes the rest',
        );
        throw translate(e);
      }
    }

    return this.reads.read(groupId, who);
  }
}

function cannotCancel(message: string): MobileContractError {
  return new MobileContractError(
    [{ field: 'id', code: 'cannot_cancel', message }],
    409,
  );
}

/** A refusal from the single cancel, in the app's words. */
function translate(e: unknown): unknown {
  if (isMobileContractError(e)) return e;
  if (e instanceof HttpException || isBookingError(e)) {
    return cannotCancel(e instanceof Error ? e.message : String(e));
  }
  return e;
}
