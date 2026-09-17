import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import { unshout } from '@application/contract/wire';
import {
  MoneyRepository,
  type MoneyOutcome,
} from '@infrastructure/persistence/money.repository';
import { bookingError } from '@application/contract/errors';
import { Money } from '@domain/shared/money';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
import type { PaymentRail } from '../../generated/prisma/enums';

/**
 * The domain rails, and the shouted words a caller sends.
 *
 * TWO LISTS ON PURPOSE. The wire contract is SCREAMING_SNAKE and the column
 * is lowercase; `unshout` folds one into the other at the edge, so an unknown
 * rail is caught here rather than at the INSERT. Accepting the lowercase form
 * directly would put the diary's vocabulary in the front end's contract,
 * which contract-vocabulary.spec.ts exists to prevent -- and duly caught.
 */
const RAILS = [
  'wallet',
  'card',
  'apple_pay',
  'cash',
  'link',
  'internal',
] as const;
const WIRE_RAILS = [
  'WALLET',
  'CARD',
  'APPLE_PAY',
  'CASH',
  'LINK',
  'INTERNAL',
] as const;

class ReasonDto {
  @ApiProperty({ example: 'customer paid at the desk' })
  @IsString()
  reason!: string;
}

export class CaptureDto extends ReasonDto {
  @ApiPropertyOptional({ enum: WIRE_RAILS, default: 'CASH' })
  @IsOptional()
  @WireEnum(WIRE_RAILS)
  rail: Uppercase<PaymentRail> = 'CASH';
}

export class RefundDto extends ReasonDto {
  @ApiProperty({ enum: ['DEPOSIT', 'FULL'] })
  @IsIn(['DEPOSIT', 'FULL'])
  mode!: 'DEPOSIT' | 'FULL';

  @ApiPropertyOptional({
    example: 12000,
    description: 'Minor units. Omit to let the mode decide.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountMinor?: number;

  @ApiPropertyOptional({ enum: WIRE_RAILS, default: 'CARD' })
  @IsOptional()
  @WireEnum(WIRE_RAILS)
  rail: Uppercase<PaymentRail> = 'CARD';
}

export class GoodwillDto extends ReasonDto {
  @ApiProperty({ example: 4000, description: 'Minor units to credit.' })
  @IsInt()
  @Min(1)
  amountMinor!: number;
}

/**
 * The money-moving desk actions.
 *
 * MANAGER ONLY, all four. Each either moves money against policy or reopens
 * a position the policy already closed, and §4 of the front-end contract
 * gates every one of them on the manager role. `@DeskOnly` keeps customers
 * out; the manager check is per-method, because a receptionist may take a
 * payment at the desk and may not hand back a refund.
 *
 * Idempotency-Key IS REQUIRED on every route here. These endpoints take and
 * return money, and a retried request that charged twice is the worst bug
 * this service could ship. A repeat with the same key returns the original
 * ledger entry and `replayed: true`, having written nothing.
 */
@ApiTags('money')
@Controller('bookings')
@DeskOnly()
export class MoneyController {
  constructor(private readonly money: MoneyRepository) {}

  @Post(':id/capture')
  @ApiOperation({
    summary: 'Take the pending link amount at the desk',
    description:
      'Supersedes the link intent: the link is invalidated in the SAME ' +
      'transaction as the capture. Leaving it live means the same deposit ' +
      'can be paid twice — once here, once on a phone in the car park — and ' +
      'the second arrives as a webhook against an already-confirmed booking.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ description: 'Captured, with the ledger entry id.' })
  @ApiConflictResponse({ description: 'Not awaiting payment.' })
  async capture(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: CaptureDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<unknown> {
    return view(
      await this.money.capture({
        bookingId: id,
        actor: actor.kind,
        actorId: actor.id,
        reason: dto.reason,
        rail: unshout(dto.rail, RAILS)!,
        idempotencyKey: required(key),
      }),
    );
  }

  @Post(':id/refund')
  @ApiOperation({
    summary: 'Refund a settled booking',
    description:
      'Writes a LINKED REVERSAL. The original capture stays exactly where it ' +
      'is and a negative row is appended beside it, so the ticket still shows ' +
      'what was taken and the register total is untouched. The ledger is ' +
      'append-only and a database trigger enforces it.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async refund(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: RefundDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<unknown> {
    manager(actor);
    return view(
      await this.money.refund({
        bookingId: id,
        actor: actor.kind,
        actorId: actor.id,
        reason: dto.reason,
        mode: dto.mode,
        amountFils: dto.amountMinor,
        rail: unshout(dto.rail, RAILS)!,
        idempotencyKey: required(key),
      }),
    );
  }

  @Post(':id/goodwill')
  @ApiOperation({
    summary: 'Credit a forfeited deposit toward a rebook',
    description:
      'WITHOUT reversing the forfeit. Both sides stay on the ledger and the ' +
      'risk score is untouched: the customer still did not turn up, and a ' +
      'goodwill gesture is not a finding that they did.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async goodwill(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: GoodwillDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<unknown> {
    manager(actor);
    return view(
      await this.money.goodwill({
        bookingId: id,
        actor: actor.kind,
        actorId: actor.id,
        reason: dto.reason,
        amountFils: dto.amountMinor,
        idempotencyKey: required(key),
      }),
    );
  }

  @Post(':id/revive')
  @ApiOperation({
    summary: 'Put a no-show back on the diary',
    description:
      'Re-opens the ORIGINAL ledger position rather than writing a refund. ' +
      'The money never left; it was forfeited against a visit that is now ' +
      'going to happen after all.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async revive(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<unknown> {
    manager(actor);
    return view(
      await this.money.revive({
        bookingId: id,
        actor: actor.kind,
        actorId: actor.id,
        reason: dto.reason,
        idempotencyKey: required(key),
      }),
    );
  }
}

function manager(actor: Actor): void {
  if (actor.kind !== 'manager') {
    throw bookingError(
      'FORBIDDEN_ROLE',
      'Only a manager may move money against policy.',
    );
  }
}

/**
 * The key is MANDATORY, not defaulted.
 *
 * Deriving one from the booking id would make every retry look like a replay
 * and every deliberate second refund look like a duplicate. The client has to
 * choose, because only the client knows whether this is the same action
 * again or a new one.
 */
function required(key: string | undefined): string {
  if (key === undefined || key.trim() === '') {
    throw bookingError(
      'BOOKING_REASON_REQUIRED',
      'Idempotency-Key is required on every money-moving request.',
      { header: 'Idempotency-Key' },
    );
  }
  return key.trim();
}

function view(o: MoneyOutcome): unknown {
  switch (o.kind) {
    case 'not_found':
      throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
    case 'illegal':
      throw bookingError('BOOKING_STATE_INVALID', o.message);
    case 'done':
      return {
        bookingId: undefined,
        code: o.code,
        ledgerEntryId: o.entryId,
        amount: Math.round(o.amountFils / 100),
        amountMinor: o.amountFils,
        amountDisplay: Money.fils(o.amountFils).toString(),
        balanceMinor: o.balanceFils,
        balanceDisplay: Money.fils(o.balanceFils).toString(),
        status: o.status.toUpperCase(),
        paymentStatus: o.paymentStatus.toUpperCase(),
        replayed: o.replayed,
      };
  }
}
