/**
 * The front door. Checks the form, works out who is asking, hands it on.
 * It decides nothing about the business.
 *
 * @DeskOnly at class level: a customer token is refused on every route.
 *
 * THIS CONTROLLER OWNS ROWS IN THIS SERVICE'S OWN DATABASE: created here,
 * edited here, deleted here, through StylistRepository. It is NOT the
 * platform staff directory. That one is StaffDirectoryController, a
 * read-only window onto platform's staff_profile over gRPC. Same word, two
 * different things, and the ids are not interchangeable.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import {
  StylistHandler,
  type StylistView,
} from '@application/queries/stylist.handler';
import { MAX_STYLIST_LABEL } from '@domain/shared/stylist';
import { ResourceIdPipe } from './resource-id.pipe';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';

/**
 * DTOs LIVE AT THE TOP OF THIS FILE, above the controller.
 *
 * Moving them into a separate .dto.ts opts every field out of
 * contract-vocabulary.spec.ts, which only scans *.controller.ts -- and the
 * suite stays green while it does.
 *
 * EVERY field carries a class-validator decorator, not only @ApiProperty.
 * The global pipe runs with whitelist:true, so a documented-but-unvalidated
 * field is silently stripped and reaches the handler as undefined, with no
 * error anywhere. The spec beside this file asserts it.
 */
export class CreateStylistDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;

  @ApiProperty({ example: 'A short human label' })
  @IsString()
  @MaxLength(MAX_STYLIST_LABEL)
  label!: string;
}

/**
 * A query DTO, not bare @Query('x') arguments.
 *
 * There is no @ApiQuery anywhere in this codebase, so a bare @Query is
 * invisible in /docs: the operation publishes no parameters at all and a
 * client generated from the spec cannot call it. A DTO documents and
 * validates in one move.
 */
export class ListStylistDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;
}

export class UpdateStylistDto {
  @ApiProperty({ example: 'A corrected label' })
  @IsString()
  @MaxLength(MAX_STYLIST_LABEL)
  label!: string;
}

@ApiTags('stylists')
@DeskOnly()
@Controller('stylists')
export class StylistsController {
  constructor(private readonly handler: StylistHandler) {}

  // Single-quoted literal paths. route-order.spec.ts is a source regex and
  // recognises nothing else -- double quotes, a constant, or the options form
  // @Controller({ path }) make it report ZERO routes, so its shadowing check
  // passes vacuously while the endpoint is genuinely unreachable.
  //
  // Literal routes are declared BEFORE ':id' routes, both in this file and
  // in the module's controllers array.

  // The `| null` in the return types below is NOT decoration. StylistHandler
  // still returns null from create, findOne and update because
  // StylistRepository is a scaffold whose bodies are commented out. The
  // controller states what the handler actually returns rather than widening
  // it with a cast, so the day the repository is implemented the nulls
  // disappear from both files together.

  @Post()
  @ApiOperation({ summary: 'TODO: what a salon person would call this' })
  @ApiCreatedResponse({ description: 'Created.' })
  @ApiConflictResponse({ description: 'The label is empty or too long.' })
  create(
    @Body() dto: CreateStylistDto,
    @CurrentActor() actor: Actor,
  ): Promise<StylistView | null> {
    return this.handler.create(
      { branchId: dto.branchId, label: dto.label },
      { id: actor.id, kind: actor.kind },
    );
  }

  @Get()
  @ApiOperation({ summary: 'Every stylist for a branch, newest first' })
  @ApiOkResponse({ description: 'The list, possibly empty.' })
  list(@Query() query: ListStylistDto): Promise<readonly StylistView[]> {
    return this.handler.list(query.branchId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One stylist' })
  @ApiOkResponse({ description: 'Found.' })
  @ApiNotFoundResponse({ description: 'No such stylist.' })
  findOne(
    @Param('id', ResourceIdPipe) id: string,
  ): Promise<StylistView | null> {
    return this.handler.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change the label',
    description: 'The author, or a manager. Other staff are refused.',
  })
  @ApiOkResponse({ description: 'Updated.' })
  @ApiNotFoundResponse({ description: 'No such stylist.' })
  @ApiForbiddenResponse({ description: 'Not yours to change.' })
  @ApiConflictResponse({ description: 'The label is empty or too long.' })
  update(
    @Param('id', ResourceIdPipe) id: string,
    @Body() dto: UpdateStylistDto,
    @CurrentActor() actor: Actor,
  ): Promise<StylistView | null> {
    return this.handler.update(id, dto.label, {
      id: actor.id,
      kind: actor.kind,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove it' })
  @ApiOkResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: 'No such stylist.' })
  @ApiForbiddenResponse({ description: 'Not yours to remove.' })
  remove(
    @Param('id', ResourceIdPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<{ message: string }> {
    return this.handler.remove(id, { id: actor.id, kind: actor.kind });
  }
}
