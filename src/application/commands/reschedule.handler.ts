import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  RescheduleRepository,
  type RescheduleInput,
} from '@infrastructure/persistence/reschedule.repository';
import { Money } from '@domain/shared/money';
import { formatMinute } from '@domain/availability/grid';
import type { ActorKind } from '@domain/booking/lifecycle';

export interface RescheduleCommand {
  readonly bookingId: string;
  /** The hold already placed on the new slot. */
  readonly holdId: string;
  readonly tradingDay: string;
  /** Mandatory. A move without a reason is unauditable. */
  readonly reason: string;
  readonly actor: ActorKind;
  readonly actorId?: string;
  readonly nowMs?: number;
}

export interface RescheduleView {
  readonly code: string;
  readonly from: string;
  readonly to: string;
  readonly moveCount: number;
  readonly lateMove: boolean;
  /** Carried, or forfeited. */
  readonly deposit: string;
  readonly depositOutcome: 'CARRIED' | 'FORFEITED';
  /** Set when the serial-rescheduler rule bites. */
  readonly nowRequires?: string;
  /** The sentence the desk reads to the customer. */
  readonly explanation: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RescheduleHandler {
  constructor(private readonly repo: RescheduleRepository) {}

  async execute(cmd: RescheduleCommand): Promise<RescheduleView> {
    if (!UUID_RE.test(cmd.bookingId)) {
      throw new NotFoundException('No such booking');
    }

    const input: RescheduleInput = {
      bookingId: cmd.bookingId,
      holdId: cmd.holdId,
      tradingDay: cmd.tradingDay,
      reason: cmd.reason,
      actor: cmd.actor,
      actorId: cmd.actorId ?? null,
      ...(cmd.nowMs !== undefined ? { nowMs: cmd.nowMs } : {}),
    };

    const result = await this.repo.move(input);

    switch (result.kind) {
      case 'not_found':
        throw new NotFoundException('No such booking');
      case 'illegal':
        throw new ConflictException(result.message);
      case 'hold_expired':
        // The wording matters at a desk: the customer is standing there and
        // the operator needs to know nothing was lost except the slot.
        throw new GoneException(
          'That slot went while you were deciding. The original booking is untouched, and offers have refreshed.',
        );
      case 'moved':
        break;
    }

    const o = result.outcome;
    const carried = o.money.kind === 'carries';

    return {
      code: result.code,
      from: result.fromStartAt.toISOString(),
      to: result.toStartAt.toISOString(),
      moveCount: o.newMoveCount,
      lateMove: o.lateMove,
      deposit: Money.fils(
        carried ? o.money.amountFils : o.money.forfeitedFils,
      ).toString(),
      depositOutcome: carried ? 'CARRIED' : 'FORFEITED',
      ...(o.acquiresDepositFils !== null
        ? { nowRequires: Money.fils(o.acquiresDepositFils).toString() }
        : {}),
      explanation: o.explanation,
    };
  }
}

export { formatMinute };
