import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  LifecycleRepository,
  type TransitionInput,
} from '@infrastructure/persistence/lifecycle.repository';
import { Money } from '@domain/shared/money';
import type {
  ActorKind,
  BookingStatus,
  CancelInitiator,
} from '@domain/booking/lifecycle';

export interface LifecycleView {
  readonly code: string;
  readonly bookingId: string;
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly paymentStatus: string;
  readonly refund?: string;
  readonly kept?: string;
  readonly lateCancel?: boolean;
  /** The sentence the desk reads to the customer. */
  readonly explanation?: string;
}

export interface LifecycleCommand {
  readonly bookingId: string;
  readonly to: BookingStatus;
  readonly actor: ActorKind;
  readonly actorId?: string;
  readonly reason?: string;
  readonly initiatedBy?: CancelInitiator;
  readonly vipStandingReservation?: boolean;
  /** Test hook, so the refund bands can be exercised without waiting a day. */
  readonly nowMs?: number;
}

@Injectable()
export class LifecycleHandler {
  constructor(private readonly repo: LifecycleRepository) {}

  async execute(cmd: LifecycleCommand): Promise<LifecycleView> {
    const input: TransitionInput = {
      bookingId: cmd.bookingId,
      to: cmd.to,
      actor: cmd.actor,
      actorId: cmd.actorId ?? null,
      reason: cmd.reason ?? null,
      ...(cmd.nowMs !== undefined ? { nowMs: cmd.nowMs } : {}),
      ...(cmd.initiatedBy !== undefined
        ? { initiatedBy: cmd.initiatedBy }
        : {}),
      ...(cmd.vipStandingReservation !== undefined
        ? { vipStandingReservation: cmd.vipStandingReservation }
        : {}),
    };

    const outcome = await this.repo.transition(input);

    // Each refusal gets the status code that matches what the caller should
    // do about it. 409 means "read fresh state and try again", 403 means
    // "get someone else to do it", 422 means "you left something out".
    switch (outcome.kind) {
      case 'not_found':
        throw new NotFoundException('No such booking');
      case 'illegal':
        throw new ConflictException(outcome.message);
      case 'forbidden':
        throw new ForbiddenException(outcome.message);
      case 'needs_reason':
        throw new UnprocessableEntityException(outcome.message);
      case 'transitioned':
        break;
    }

    const b = outcome.booking;
    const m = outcome.money;

    return {
      code: b.code,
      bookingId: b.bookingId,
      from: b.from,
      to: b.to,
      paymentStatus: b.paymentStatus,
      ...(m === null
        ? {}
        : {
            refund: Money.fils(m.refundFils).toString(),
            kept: Money.fils(m.keptFils).toString(),
            lateCancel: m.lateCancel,
            explanation: m.explanation,
          }),
    };
  }
}
