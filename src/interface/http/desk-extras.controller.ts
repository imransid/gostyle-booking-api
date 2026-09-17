import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { DeskExtrasHandler } from '@application/commands/desk-extras.handler';
import {
  DeskExtrasRepository,
  type ExtraOutcome,
} from '@infrastructure/persistence/desk-extras.repository';
import { bookingError } from '@application/contract/errors';
import { WireEnum } from './wire-enum.decorator';
import { unshout } from '@application/contract/wire';
import { BranchId } from './branch.decorator';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
import { MIN_SHORTENED_MIN } from '@domain/booking/lifecycle';

const RAILS = ['wallet', 'card', 'apple_pay', 'cash', 'link'] as const;
const WIRE_RAILS = ['WALLET', 'CARD', 'APPLE_PAY', 'CASH', 'LINK'] as const;

class ReasonDto {
  @ApiProperty({ example: 'checked in the wrong customer' })
  @IsString()
  reason!: string;
}

export class ShortenDto extends ReasonDto {
  @ApiProperty({ example: 30, description: `At least ${MIN_SHORTENED_MIN}.` })
  @IsInt()
  @Min(MIN_SHORTENED_MIN)
  toDurationMinutes!: number;
}

export class LateCaptureDto {
  @ApiProperty({ example: 'pi_abc123' })
  @IsString()
  intentId!: string;

  @ApiProperty({ example: 24000, description: 'Minor units that arrived.' })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiPropertyOptional({ enum: WIRE_RAILS, default: 'CARD' })
  @IsOptional()
  @WireEnum(WIRE_RAILS)
  rail: (typeof WIRE_RAILS)[number] = 'CARD';
}

export class BulkRemindDto {
  @ApiPropertyOptional({ example: 50, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit = 50;
}

export class CourseDrawDto {
  @ApiProperty({ description: 'The visit being settled against the course.' })
  @IsString()
  bookingId!: string;
}

/**
 * The remaining desk actions from the module contract.
 *
 * @DeskOnly throughout. Undoing a check-in releases a chair, shortening a
 * visit hands minutes back to the diary, and a waiver bypasses a safety
 * gate — none of them are things a customer does to their own booking.
 */
@ApiTags('desk')
@Controller('bookings')
@DeskOnly()
export class DeskExtrasController {
  constructor(
    private readonly handler: DeskExtrasHandler,
    private readonly repo: DeskExtrasRepository,
  ) {}

  @Post(':id/remind')
  @ApiOperation({
    summary: 'Send the confirm-or-move reminder now',
    description:
      'Quiet hours (21:00–09:00) QUEUE rather than fail — a desk agent ' +
      'pressing this at 22:30 wants the customer reminded, not woken, and ' +
      'refusing would just move the waiting onto a person. `delivered` is ' +
      'always false: the event is written to the outbox and no message ' +
      'transport is wired yet.',
  })
  remind(@Param('id', ResourceIdPipe) id: string): Promise<unknown> {
    return this.handler.remind(id);
  }

  @Post('reminders/bulk')
  @ApiOperation({ summary: 'Remind everyone who has not been reminded' })
  bulk(
    @BranchId() branchId: string,
    @Body() dto: BulkRemindDto,
  ): Promise<unknown> {
    return this.handler.remindBulk(branchId, dto.limit);
  }

  @Post(':id/check-in/undo')
  @ApiOperation({
    summary: 'Undo a check-in, within five minutes',
    description:
      'Releases the chair and returns the booking to CONFIRMED. Past five ' +
      'minutes it is refused: the chair has been given away by then, and ' +
      'undoing would be a claim that the customer never arrived.',
  })
  @ApiConflictResponse({ description: 'Too late, or not checked in.' })
  async undo(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    return done(
      await this.repo.undoCheckIn({
        bookingId: id,
        reason: dto.reason,
        actor: actor.kind,
        actorId: actor.id,
      }),
    );
  }

  @Post(':id/shorten')
  @ApiOperation({
    summary: 'Triage a late arrival down to what still fits',
    description:
      'The RESERVATIONS shrink with the booking, so the minutes freed are ' +
      'genuinely handed back to the diary rather than freed on paper. A ' +
      `stub under ${MIN_SHORTENED_MIN} minutes is refused — that is a ` +
      'disappointed customer, not a service.',
  })
  async shorten(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: ShortenDto,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    return done(
      await this.repo.shorten({
        bookingId: id,
        toDurationMin: dto.toDurationMinutes,
        reason: dto.reason,
        actor: actor.kind,
        actorId: actor.id,
      }),
    );
  }

  @Post(':id/waiver')
  @ApiOperation({
    summary: 'Record a patch-test waiver. Manager only',
    description:
      'Written to the audit trail with the manager and the reason, not to a ' +
      'flag. The question support asks months later is "who waived it and ' +
      'why", and a boolean cannot answer it.',
  })
  async waiver(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentActor() actor: Actor,
  ): Promise<unknown> {
    if (actor.kind !== 'manager') {
      throw bookingError(
        'FORBIDDEN_ROLE',
        'Only a manager may waive a patch test.',
      );
    }
    return done(
      await this.repo.waiver({
        bookingId: id,
        reason: dto.reason,
        actor: actor.kind,
        actorId: actor.id,
      }),
    );
  }

  @Post(':id/late-capture')
  @ApiOperation({
    summary: 'Replay a payment that arrived after the window closed',
    description:
      'Runs THE SAME decision the gateway webhook runs: reinstate if the ' +
      'slot survived, refund in full if it was resold. Normally the webhook ' +
      'drives this; the endpoint exists so the desk can replay it.',
  })
  @ApiOkResponse({ description: 'REINSTATED or REFUNDED, with the reason.' })
  lateCapture(
    @Param('id') code: string,
    @Body() dto: LateCaptureDto,
  ): Promise<unknown> {
    return this.handler.lateCapture({
      bookingCode: code,
      intentId: dto.intentId,
      // The wire says `amountMinor`; the domain says fils. Same integer,
      // renamed once here rather than at each use.
      amountFils: dto.amountMinor,
      rail: unshout(dto.rail, RAILS)!,
    });
  }

  @Post('series-admin/:id/course-draw')
  @ApiOperation({
    summary: 'Settle one visit against a prepaid course balance',
    description:
      'The amount comes from the draw SCHEDULE, not a division: the draws ' +
      'must sum back to exactly what was sold, or the course never closes at ' +
      'zero and somebody shuts it by hand. VAT is recognised per draw.',
  })
  courseDraw(
    @Param('id', ResourceIdPipe) seriesId: string,
    @Body() dto: CourseDrawDto,
  ): Promise<unknown> {
    return this.handler.courseDraw(seriesId, dto.bookingId);
  }
}

function done(o: ExtraOutcome): unknown {
  switch (o.kind) {
    case 'not_found':
      throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
    case 'illegal':
      throw bookingError('BOOKING_STATE_INVALID', o.message);
    case 'done':
      return { code: o.code, ...(o.detail as object) };
  }
}
