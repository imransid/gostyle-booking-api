import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WaitlistRepository } from '@infrastructure/persistence/waitlist.repository';
import { PlaceHoldHandler } from './place-hold.handler';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import { formatMinute } from '@domain/availability/grid';

export interface JoinCommand {
  readonly branchId: string;
  readonly customerId: string;
  readonly serviceId: string;
  readonly tradingDay: string;
  readonly windowFromMin: number;
  readonly windowToMin: number;
  readonly preferredStaffId: string | null;
}

export interface JoinView {
  readonly entryId: string;
  readonly serviceId: string;
  readonly tradingDay: string;
  readonly window: string;
  readonly preferredStaff: string | null;
  /** How many are ahead of them, so the message can be honest. */
  readonly position: number;
}

export interface AcceptView {
  /** The client confirms this hold through POST /v1/bookings, as normal. */
  readonly holdId: string;
  readonly start: string;
  readonly end: string;
  readonly expiresInSeconds: number;
  readonly note: string;
}

@Injectable()
export class WaitlistHandler {
  constructor(
    private readonly repo: WaitlistRepository,
    private readonly holds: PlaceHoldHandler,
    @Inject(CUSTOMER_CONTEXT)
    private readonly customers: CustomerContextReader,
  ) {}

  async join(cmd: JoinCommand): Promise<JoinView> {
    if (cmd.windowToMin <= cmd.windowFromMin) {
      throw new ConflictException('The window has to end after it starts.');
    }
    const { entryId, position } = await this.repo.join(cmd);
    return {
      entryId,
      serviceId: cmd.serviceId,
      tradingDay: cmd.tradingDay,
      window: `${formatMinute(cmd.windowFromMin)} to ${formatMinute(cmd.windowToMin)}`,
      preferredStaff: cmd.preferredStaffId,
      position,
    };
  }

  /**
   * Take the offered slot.
   *
   * THIS DOES NOT CREATE A BOOKING. It places an ordinary hold and hands the
   * id back, and the client confirms through POST /v1/bookings exactly as it
   * would for any other booking.
   *
   * That is the point. Accepting "converts through the normal confirm path,
   * which means the requirement is resolved fresh": an acceptance that
   * triggers a deposit lands as PendingPayment with the link in the same
   * thread, not as a free confirmation. A separate waitlist-confirm would be
   * a second place for the deposit rules to live, and the two would drift.
   */
  async accept(entryId: string): Promise<AcceptView> {
    const offer = await this.repo.liveOffer(entryId);
    if (offer === null) {
      throw new NotFoundException(
        'That offer has expired or was already taken.',
      );
    }

    const hold = await this.holds.execute({
      branchId: offer.branchId,
      tradingDay: offer.tradingDay,
      serviceIds: [offer.serviceId],
      startMin: offer.startMin,
      preferredStaffId: offer.staffId,
      customerId: offer.customerId,
      channel: 'desk',
    });

    await this.repo.markAccepted(entryId);

    return {
      holdId: hold.holdId,
      start: hold.start,
      end: hold.end,
      expiresInSeconds: hold.expiresInSeconds,
      note: 'Confirm this hold through POST /v1/bookings. The requirement is resolved fresh, so a deposit may be due.',
    };
  }

  async decline(entryId: string): Promise<{ message: string }> {
    const offer = await this.repo.liveOffer(entryId);
    if (offer === null) {
      throw new NotFoundException('That offer has expired.');
    }

    const result = await this.repo.passDown(entryId, offer.branchId, {
      bookingCode: offer.bookingCode,
      serviceId: offer.serviceId,
      tradingDay: offer.tradingDay,
      startMin: offer.startMin,
      durationMin: offer.durationMin,
      staffId: offer.staffId,
    });

    return {
      message: result.offered
        ? 'Passed to the next person on the list.'
        : 'Nobody else was waiting for that slot.',
    };
  }
}
