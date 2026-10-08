import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import {
  CheckInDeskHandler,
  type DeskRequestView,
  type ReceptionItem,
} from '@application/commands/check-in-desk.handler';
import type { LifecycleView } from '@application/commands/lifecycle.handler';
import { BookingScope } from './booking-scope';
import { BranchId } from './branch.decorator';
import { IdempotentInterceptor } from './idempotent.interceptor';
import { SelfCheckInEnabledGuard } from './self-check-in.flag';

/** Every self check-in route holds staff to the scope rule, flag or not. */
const ALWAYS = { staff: 'always' } as const;

export class RejectCheckInDto {
  @ApiProperty({
    example: 'Not at the salon',
    description:
      'Required, and not blank. The desk’s own words: shown to the ' +
      'desk, never to the customer.',
  })
  @IsString()
  reason!: string;
}

/**
 * SELF CHECK-IN, the desk's answer to one booking's request:
 *
 *   POST /v1/bookings/:id/check-in-request/approve
 *   POST /v1/bookings/:id/check-in-request/reject   { reason }
 *
 * Behind SELF_CHECK_IN_V1 (off: 404) and @DeskOnly (a customer: 403).
 *
 * SCOPE ALWAYS ON (D2): refuseOutOfScope with { staff: 'always' } first in
 * each route, whatever STAFF_SCOPE_V1 says. Another tenant's booking, or
 * another branch's for a branch-bound token, is 404 "No such booking".
 *
 * Idempotent where the desk sends a key, as the other desk writes: a retried
 * tap replays the first answer instead of a confusing "nothing waiting".
 */
@ApiTags('self check-in')
@UseGuards(SelfCheckInEnabledGuard)
@UseInterceptors(IdempotentInterceptor)
@Controller('bookings/:id/check-in-request')
@DeskOnly()
export class CheckInDeskController {
  constructor(
    private readonly scope: BookingScope,
    private readonly desk: CheckInDeskHandler,
  ) {}

  @Post('approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve the waiting check-in request: check the customer in',
    description:
      'Runs the ordinary check-in first (POST /v1/bookings/:id/check-in: ' +
      'its timing gate, state machine, history and event, unchanged), then ' +
      'marks the request APPROVED. If the check-in refuses, that is the ' +
      'answer and the request still waits.',
  })
  @ApiOkResponse({ description: '{ request, checkIn }.' })
  @ApiConflictResponse({
    description:
      'BOOKING_STATE_INVALID: nothing is waiting (details.request: the ' +
      'latest state, or null). Or whatever the check-in refuses.',
  })
  @ApiNotFoundResponse({
    description: 'No such booking, or not in the caller’s salon.',
  })
  async approve(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ request: DeskRequestView; checkIn: LifecycleView }> {
    await this.scope.refuseOutOfScope(
      { bookingId: id },
      actor,
      'POST /v1/bookings/:id/check-in-request/approve',
      ALWAYS,
    );
    return this.desk.approve({
      bookingId: id,
      actor: actor.kind,
      actorId: actor.id,
    });
  }

  @Post('reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject the waiting check-in request, with a reason',
    description:
      'The booking is not touched: it goes back to the ordinary rules, the ' +
      'auto no-show included. The customer may not raise again for it.',
  })
  @ApiOkResponse({ description: '{ request }, REJECTED.' })
  @ApiConflictResponse({
    description: 'BOOKING_STATE_INVALID: nothing is waiting.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'BOOKING_REASON_REQUIRED: the reason is blank.',
  })
  @ApiNotFoundResponse({
    description: 'No such booking, or not in the caller’s salon.',
  })
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectCheckInDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ request: DeskRequestView }> {
    await this.scope.refuseOutOfScope(
      { bookingId: id },
      actor,
      'POST /v1/bookings/:id/check-in-request/reject',
      ALWAYS,
    );
    return this.desk.reject({
      bookingId: id,
      actor: actor.kind,
      actorId: actor.id,
      reason: dto.reason,
    });
  }
}

/**
 * SELF CHECK-IN, the reception list:
 *
 *   GET /v1/check-in-requests?branchId=...
 *
 * Its own path, not under /v1/bookings, where BookingsController's
 * `@Get(':id')` would take "check-in-requests" for a booking id.
 *
 * Behind SELF_CHECK_IN_V1 and @DeskOnly. The branch is @BranchId's, as every
 * desk list. SCOPE ALWAYS ON: a token with no branch may name any branch, so
 * every row is kept or hidden by the same rule as the by-id routes
 * (BookingScope.keepInScope), and another tenant's branch reads empty.
 */
@ApiTags('self check-in')
@UseGuards(SelfCheckInEnabledGuard)
@Controller('check-in-requests')
@DeskOnly()
export class ReceptionCheckInController {
  constructor(
    private readonly scope: BookingScope,
    private readonly desk: CheckInDeskHandler,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The reception list: who says they are here',
    description:
      '`waiting`: requests nobody has answered, oldest first. ' +
      '`needsDecision`: bookings the auto no-show leaves to the desk ' +
      'because the customer said they arrived (mostly nobody answered in ' +
      'time): still CONFIRMED and past start plus 30 minutes, oldest first, ' +
      'at most 100. Close each one by hand: check in, no-show or cancel.',
  })
  @ApiOkResponse({ description: '{ branchId, waiting, needsDecision }.' })
  async list(
    @BranchId() branchId: string,
    @CurrentActor() actor: Actor,
  ): Promise<{
    branchId: string;
    waiting: ReceptionItem[];
    needsDecision: ReceptionItem[];
  }> {
    const route = 'GET /v1/check-in-requests';
    const list = await this.desk.reception(branchId);
    const visible = (entries: typeof list.waiting): ReceptionItem[] =>
      this.scope
        .keepInScope(actor, entries, (e) => e.scope, route)
        .map((e) => e.item);
    return {
      branchId,
      waiting: visible(list.waiting),
      needsDecision: visible(list.needsDecision),
    };
  }
}
