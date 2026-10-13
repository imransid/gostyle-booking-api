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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { bookingError } from '@application/contract/errors';
import type { GroupReader } from '@application/queries/mobile-group-read.handler';
import {
  MobileGroupCheckInHandler,
  type GroupCheckInView,
} from '@application/commands/mobile-group-check-in.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { customerOnly } from './check-in-request.controller';
import { SelfCheckInEnabledGuard } from './self-check-in.flag';
import { MobileGroupEnabledGuard } from './mobile-group.flag';
import { MobileGroupCheckInEnabledGuard } from './mobile-group-check-in.flag';

/**
 * "We are here" for an app party: the booker's one tap, raised as the single
 * check-in request on each lane (MobileGroupCheckInHandler).
 *
 * THREE SWITCHES, all of them on or 404: self check-in, mobile groups, and
 * this route's own.
 *
 * No IdempotentInterceptor, the same as the single route: a stored answer
 * would show a lane WAITING after the desk answered it, and sending again is
 * already safe (the lanes answer WAITING).
 */
@Controller('mobile-booking/group/:groupId/check-in')
@UseGuards(
  SelfCheckInEnabledGuard,
  MobileGroupEnabledGuard,
  MobileGroupCheckInEnabledGuard,
)
export class MobileGroupCheckInController {
  constructor(private readonly checkIns: MobileGroupCheckInHandler) {}

  @Post()
  @ApiOperation({
    summary: 'Say "we are here" for my party',
    description:
      'The booker only. Raises the single check-in request on each lane of ' +
      'the party (or only the lanes in `bookingIds`), each for the desk to ' +
      'approve as usual. A lane refused (too early, say) does not stop the ' +
      "others: it carries the single route's own error. Sending it again is " +
      'safe.',
  })
  @ApiCreatedResponse({
    description: 'At least one lane raised: { groupId, lanes }.',
  })
  @ApiOkResponse({
    description: 'Nothing new, a lane already waiting: { groupId, lanes }.',
  })
  @ApiConflictResponse({
    description:
      'Nothing to do for anyone. Every lane refused for one reason: that ' +
      'reason, as the single route says it. Otherwise ' +
      'BOOKING_GROUP_CHECKIN_NONE, details { groupId, lanes }.',
  })
  @ApiForbiddenResponse({ description: 'Not a customer token.' })
  @ApiNotFoundResponse({
    description:
      'No such party, a desk party, not the booker, or a switch is off.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'not_found on bookingIds: one is not a lane of this party.',
  })
  async raise(
    @Param('groupId') groupId: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GroupCheckInView> {
    customerOnly(actor);
    const out = await this.checkIns.raise(
      groupId,
      readerOf(actor),
      bookingIdsOf(body),
    );
    res.status(out.status);
    return out.view;
  }

  @Get()
  @ApiOperation({
    summary: "My party's check-in, lane by lane",
    description: 'The booker only. Each lane with its latest request, or null.',
  })
  @ApiOkResponse({ description: '{ groupId, lanes }.' })
  @ApiForbiddenResponse({ description: 'Not a customer token.' })
  @ApiNotFoundResponse({
    description:
      'No such party, a desk party, not the booker, or a switch is off.',
  })
  read(@Param('groupId') groupId: string, @CurrentActor() actor: Actor) {
    customerOnly(actor);
    return this.checkIns.read(groupId, readerOf(actor));
  }
}

/** Who is asking, as the party routes take it (the same as the cancel). */
function readerOf(actor: Actor): GroupReader {
  return {
    actorId: actor.id ?? 'anonymous',
    actorKind: actor.kind,
    actorBranchId: actor.branchId,
  };
}

/**
 * The optional `bookingIds`, read by hand: no body (or no field) means every
 * lane. Anything else that is not a list of strings is a 400, before
 * anything is looked up.
 */
function bookingIdsOf(body: unknown): string[] | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw bookingError(
      'BOOKING_VALIDATION_FAILED',
      'The body must be an object.',
    );
  }
  const ids = (body as { bookingIds?: unknown }).bookingIds;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
    throw bookingError(
      'BOOKING_VALIDATION_FAILED',
      'bookingIds must be a list of booking ids.',
    );
  }
  return ids as string[];
}
