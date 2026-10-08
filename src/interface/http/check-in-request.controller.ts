import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { bookingError } from '@application/contract/errors';
import {
  CheckInRequestHandler,
  type CheckInRequestView,
} from '@application/commands/check-in-request.handler';
import { BookingScope } from './booking-scope';
import { SelfCheckInEnabledGuard } from './self-check-in.flag';

/**
 * The raise's body, all of it optional: no body is "I am here" with no chair,
 * which is also the app's Wait for Staff.
 */
export class RaiseCheckInRequestDto {
  @ApiPropertyOptional({
    description:
      'AT A CHAIR: the raw token off the chair’s QR card, exactly as ' +
      'scanned. booking-api asks platform which chair it is, once, and the ' +
      'request carries the chair. Absent: no chair (Wait for Staff).',
    example: 'q7Xk2mP9rT4vW8yZ1aB3cD',
  })
  @IsOptional()
  @IsString()
  chairToken?: string;

  @ApiPropertyOptional({
    description:
      'The app’s user agent, recorded on the salon’s scan of the card. ' +
      'customer-api forwards the app’s own; this request’s header is ' +
      'customer-api’s, so it is never read.',
    example: 'GoStyle/1.4 (iPhone; iOS 18.1)',
  })
  @IsOptional()
  @IsString()
  userAgent?: string;
}

/** Every self check-in route holds staff to the scope rule, flag or not. */
const ALWAYS = { staff: 'always' } as const;

/**
 * SELF CHECK-IN, the customer's side: "I am here", and the desk's answer.
 *
 *   POST /v1/bookings/:id/check-in-request   raise one
 *   GET  /v1/bookings/:id/check-in-request   the latest one, or null
 *
 * Behind SELF_CHECK_IN_V1, off by default: off, both are a 404.
 *
 * A CUSTOMER'S ROUTES ONLY. Staff check a customer in with POST
 * /v1/bookings/:id/check-in, as they always have; a staff token here is a
 * 403 before anything is looked up, so the answer says nothing about the
 * id. The desk's side (approve, reject, the reception list) is its own
 * controller.
 *
 * WHOSE BOOKING: BookingScope.refuseOutOfScope, first in each handler, with
 * { staff: 'always' } (D2). For a customer it is their own booking or 404
 * "No such booking", the same answer as a booking that does not exist; that
 * branch never reads STAFF_SCOPE_V1. The staff rule cannot be reached here
 * today (customerOnly runs first), and is always on if it ever is.
 *
 * NO IDEMPOTENCY STORE, on purpose. A raise is already safe to repeat (a
 * second one answers with the request already waiting), and a stored reply
 * replayed later would show a WAITING the desk has since answered.
 */
@ApiTags('self check-in')
@UseGuards(SelfCheckInEnabledGuard)
@Controller('bookings/:id/check-in-request')
export class CheckInRequestController {
  constructor(
    private readonly scope: BookingScope,
    private readonly requests: CheckInRequestHandler,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Say "I am here" for my own booking',
    description:
      'Raises a check-in request for the desk to approve. It does not check ' +
      'the booking in: the desk does, and approving runs the ordinary ' +
      'check-in. While a request waits, the booking is never marked a ' +
      'no-show automatically. Opens when the desk check-in opens (30 minutes ' +
      'before the start) and closes at the end time. With `chairToken`, the ' +
      'request carries the chair the customer scanned (docs/chair-check-in.md); ' +
      'without, it carries none.',
  })
  @ApiCreatedResponse({ description: 'Raised: { request }, WAITING.' })
  @ApiOkResponse({
    description: 'One was already waiting: { request }, the same one.',
  })
  @ApiConflictResponse({
    description:
      'BOOKING_STATE_INVALID (not CONFIRMED), BOOKING_CHECKIN_WINDOW (too ' +
      'early: windowOpensAt; or closed), BOOKING_CHECKIN_REJECTED (the desk ' +
      'said no; see the desk). BOOKING_CHAIR_REFUSED: not with that chair; ' +
      'show `message`, and `details.reason` is CARD_OUT_OF_DATE, ' +
      'OTHER_SALON, CHAIR_NOT_AVAILABLE (take another chair) or UNKNOWN_CARD.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'DEPENDENCY_UNAVAILABLE, details { reason: CHAIR_CHECK_UNAVAILABLE, ' +
      'fallback: WAIT_FOR_STAFF }: the chair could not be checked just now. ' +
      'Not "check-in is broken": raise again with no chairToken (Wait for ' +
      'Staff), which never calls platform, and the desk checks them in.',
  })
  @ApiForbiddenResponse({ description: 'Not a customer token.' })
  @ApiNotFoundResponse({
    description: 'No such booking, or not the caller’s. Or the flag is off.',
  })
  async raise(
    @Param('id') id: string,
    @Body() body: RaiseCheckInRequestDto,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ request: CheckInRequestView }> {
    customerOnly(actor);
    await this.scope.refuseOutOfScope(
      { bookingId: id },
      actor,
      'POST /v1/bookings/:id/check-in-request',
      ALWAYS,
    );
    // The server's clock, never the caller's: no nowMs is passed.
    const out = await this.requests.raise({
      bookingId: id,
      actor: actor.kind,
      actorId: actor.id,
      // Only what was sent: no body is the very call it was before chairs.
      ...(body.chairToken !== undefined ? { chairToken: body.chairToken } : {}),
      ...(body.userAgent !== undefined ? { userAgent: body.userAgent } : {}),
    });
    res.status(out.created ? 201 : 200);
    return { request: out.request };
  }

  @Get()
  @ApiOperation({
    summary: 'My latest check-in request for this booking',
    description:
      'WAITING, APPROVED, REJECTED, EXPIRED (nobody answered before the ' +
      'end time) or CLOSED (the booking moved on another way). ' +
      '`request` is null if none was ever raised.',
  })
  @ApiOkResponse({ description: '{ request } or { request: null }.' })
  @ApiForbiddenResponse({ description: 'Not a customer token.' })
  @ApiNotFoundResponse({
    description: 'No such booking, or not the caller’s. Or the flag is off.',
  })
  async read(
    @Param('id') id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ request: CheckInRequestView | null }> {
    customerOnly(actor);
    await this.scope.refuseOutOfScope(
      { bookingId: id },
      actor,
      'GET /v1/bookings/:id/check-in-request',
      ALWAYS,
    );
    return { request: await this.requests.latest(id) };
  }
}

/** Before any lookup, so a refusal says nothing about the id. */
function customerOnly(actor: Actor): void {
  if (actor.kind === 'customer') return;
  throw bookingError(
    'FORBIDDEN_ROLE',
    'Only the customer raises a check-in request. The desk checks in with ' +
      'POST /v1/bookings/:id/check-in.',
  );
}
