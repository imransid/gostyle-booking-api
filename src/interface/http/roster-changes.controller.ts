import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { unshout } from '@application/contract/wire';
import {
  RosterChangeHandler,
  type RosterChangeView,
} from '@application/commands/roster-change.handler';
import type {
  Resolution,
  RosterChangeKind,
} from '@domain/booking/roster-change';
import type { WireGate } from '@application/contract/wire';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const ROSTER_CHANGE_KINDS = [
  'shift_conflict',
  'closure_sweep',
  'chair_out_of_service',
] as const;

const RESOLUTIONS = [
  'reassign',
  'move',
  'override',
  'accept_cancellation',
] as const;

export class OpenRosterChangeDto {
  @ApiProperty()
  @IsString()
  branchId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @Matches(DAY)
  tradingDay!: string;

  @ApiProperty({
    enum: ['SHIFT_CONFLICT', 'CLOSURE_SWEEP', 'CHAIR_OUT_OF_SERVICE'],
  })
  @IsIn(['SHIFT_CONFLICT', 'CLOSURE_SWEEP', 'CHAIR_OUT_OF_SERVICE'])
  kind!: Uppercase<RosterChangeKind>;

  @ApiPropertyOptional({
    example: 'maya',
    description: 'Required for a shift conflict.',
  })
  @IsOptional()
  @IsString()
  staffId?: string;

  @ApiPropertyOptional({
    example: 'color',
    description: 'Required for a chair going out of service.',
  })
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiProperty({ example: 'called in sick' })
  @IsString()
  reason!: string;
}

export class ResolveItemDto {
  @ApiProperty({
    enum: ['reassign', 'move', 'override', 'accept_cancellation'],
    description:
      'REASSIGN and MOVE are recorded as resolved; OVERRIDE is a manager ' +
      'accepting the consequence; ACCEPT_CANCELLATION applies the prepared ' +
      'salon cancellation.',
  })
  @IsIn(['REASSIGN', 'MOVE', 'OVERRIDE', 'ACCEPT_CANCELLATION'])
  resolution!: Uppercase<Resolution>;
}

/**
 * The disruption worklist and its commit gate.
 *
 * The roster lives in another service. It registers a PROPOSED edit here,
 * we scan what it disturbs and repair what the ladder can, and it asks this
 * endpoint before committing. The gate is a trigger in the database, so a
 * caller that ignores the answer is refused anyway.
 */
@ApiTags('roster-changes')
@Controller('roster-changes')
export class RosterChangesController {
  constructor(private readonly handler: RosterChangeHandler) {}

  @Post()
  @ApiOperation({
    summary: 'Register a proposed roster edit and repair what it disturbs',
    description:
      'Collects every affected booking into a worklist and runs the 14.6 ' +
      'ladder. Rungs 1 to 3 are applied automatically. A booking that reaches ' +
      'rung 4 stays open with the cancellation prepared but NOT applied.',
  })
  @ApiCreatedResponse({ description: 'The change, its worklist and the gate.' })
  async open(
    @Body() dto: OpenRosterChangeDto,
    @CurrentActor() actor: Actor,
  ): Promise<RosterChangeView> {
    return this.handler.open({
      branchId: dto.branchId,
      tradingDay: dto.tradingDay,
      // Folded down at the edge. unshout() takes the allowed list, so an
      // unknown word is caught here rather than at the INSERT.
      kind: unshout(dto.kind, ROSTER_CHANGE_KINDS)!,
      staffId: dto.staffId ?? null,
      resourceType: dto.resourceType ?? null,
      reason: dto.reason,
      actorId: actor.id,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'The worklist and whether the edit may commit' })
  @ApiNotFoundResponse()
  async view(@Param('id', new ParseUUIDPipe()) id: string): Promise<unknown> {
    return this.handler.view(id);
  }

  @Post(':id/items/:itemId/resolve')
  @ApiOperation({
    summary: 'Resolve one worklist item',
    description:
      'Returns the gate, so the caller sees whether it may now commit.',
  })
  @ApiOkResponse({ description: 'The gate after this resolution.' })
  @ApiNotFoundResponse({
    description: 'The item is not open, or does not exist.',
  })
  async resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: ResolveItemDto,
    @CurrentActor() actor: Actor,
  ): Promise<WireGate> {
    return this.handler.resolve(
      id,
      itemId,
      unshout(dto.resolution, RESOLUTIONS)!,
      {
        kind: actor.kind,
        id: actor.id,
      },
    );
  }

  @Post(':id/commit')
  @ApiOperation({
    summary: 'Commit the roster edit',
    description:
      'Refused while any booking is unresolved. The refusal comes from a ' +
      'database trigger, not from this method, so it cannot be bypassed.',
  })
  @ApiOkResponse({ description: 'Committed, or the reason it was refused.' })
  @ApiConflictResponse({ description: 'The worklist is not clear.' })
  async commit(@Param('id', new ParseUUIDPipe()) id: string): Promise<{
    committed: boolean;
    gate: WireGate;
    message: string;
  }> {
    return this.handler.commit(id);
  }
}
