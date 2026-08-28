import { shout, type Shouted } from '@application/contract/wire';
import type { PaymentStatus } from '../../generated/prisma/enums';
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
import { Inject } from '@nestjs/common';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import { settle } from '@domain/booking/quote';
import { Money } from '@domain/shared/money';
import type {
  ActorKind,
  BookingStatus,
  CancelInitiator,
} from '@domain/booking/lifecycle';

export interface LifecycleView {
  readonly code: string;
  readonly bookingId: string;
  readonly from: Shouted<BookingStatus>;
  readonly to: Shouted<BookingStatus>;
  readonly paymentStatus: Shouted<PaymentStatus | 'unchanged'>;
  readonly refund?: string;
  readonly kept?: string;
  readonly lateCancel?: boolean;
  /** The sentence the desk reads to the customer. */
  readonly explanation?: string;
  /** Present on settlement. The receipt. */
  readonly receipt?: {
    readonly subtotal: string;
    readonly tierDiscount: string;
    readonly promo: string;
    readonly base: string;
    readonly tip: string;
    readonly vat: string;
    readonly depositApplied: string;
    readonly loyaltyRedeem: string;
    readonly due: string;
    readonly credit: string;
    readonly taxExempt: boolean;
  };
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
  /**
   * What the register added. Only meaningful on completed -> settled.
   *
   * Retail arrives as a TOTAL, not itemised: the point of sale owns products,
   * this service owns the arithmetic.
   */
  readonly checkout?: {
    readonly retailFils?: number;
    readonly tipFils?: number;
    readonly tipPercent?: number;
    readonly loyaltyRedeemFils?: number;
    /** The caller validated the code. No code table lives here yet. */
    readonly promoApplies?: boolean;
    readonly taxExemptReason?: string;
    readonly rail?: string;
  };
}

/**
 * A malformed id is a 404, not a 500. Without this, Postgres rejects the
 * uuid cast with 22P02 and the caller gets an internal error for what is
 * really just a wrong id.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LifecycleHandler {
  constructor(
    private readonly repo: LifecycleRepository,
    @Inject(CUSTOMER_CONTEXT)
    private readonly customers: CustomerContextReader,
  ) {}

  async execute(cmd: LifecycleCommand): Promise<LifecycleView> {
    if (!UUID_RE.test(cmd.bookingId)) {
      throw new NotFoundException('No such booking');
    }

    let settlement: ReturnType<typeof settle> | null = null;

    const input: TransitionInput & {
      settlement?: TransitionInput['settlement'];
    } = {
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

    // Settlement is the only transition that needs money computed BEFORE the
    // write, because the arithmetic depends on the customer's tier and on
    // what the ledger says was actually captured. Every other transition
    // decides its money inside the transaction.
    if (cmd.to === 'settled') {
      const ticket = await this.repo.ticketFor(cmd.bookingId);
      if (ticket === null) throw new NotFoundException('No such booking');

      const customer = await this.customers.load(ticket.customerId);
      const co = cmd.checkout ?? {};

      const bill = settle({
        serviceFils: ticket.serviceFils,
        addOnFils: 0,
        retailFils: co.retailFils ?? 0,
        tier: customer.tier,
        promoApplies: co.promoApplies ?? false,
        ...(co.tipFils !== undefined ? { tipFils: co.tipFils } : {}),
        ...(co.tipPercent !== undefined ? { tipPercent: co.tipPercent } : {}),
        // From the LEDGER, not the booking row. A goodwill credit or a partial
        // refund between confirm and checkout moves the real figure.
        depositAppliedFils: ticket.capturedFils,
        loyaltyRedeemFils: co.loyaltyRedeemFils ?? 0,
        ...(co.taxExemptReason !== undefined
          ? { taxExemptReason: co.taxExemptReason }
          : {}),
      });

      settlement = bill;
      input.settlement = {
        baseFils: bill.baseFils,
        tipFils: bill.tipFils,
        vatFils: bill.vatFils,
        depositAppliedFils: bill.depositAppliedFils,
        loyaltyRedeemFils: bill.loyaltyRedeemFils,
        dueFils: bill.dueFils,
        creditFils: bill.creditFils,
        taxExempt: bill.taxExempt,
        rail: co.rail ?? 'card',
      };
    }

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
      from: shout(b.from),
      to: shout(b.to),
      paymentStatus: shout(b.paymentStatus),
      ...(settlement === null
        ? {}
        : {
            receipt: {
              subtotal: Money.fils(settlement.subtotalFils).toString(),
              tierDiscount: Money.fils(settlement.tierDiscountFils).toString(),
              promo: Money.fils(settlement.promoFils).toString(),
              base: Money.fils(settlement.baseFils).toString(),
              tip: Money.fils(settlement.tipFils).toString(),
              vat: Money.fils(settlement.vatFils).toString(),
              depositApplied: Money.fils(
                settlement.depositAppliedFils,
              ).toString(),
              loyaltyRedeem: Money.fils(
                settlement.loyaltyRedeemFils,
              ).toString(),
              due: Money.fils(settlement.dueFils).toString(),
              credit: Money.fils(settlement.creditFils).toString(),
              taxExempt: settlement.taxExempt,
            },
          }),
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
