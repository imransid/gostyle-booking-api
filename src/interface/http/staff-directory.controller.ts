/**
 * Stylists AS PLATFORM KNOWS THEM, for the customer app.
 *
 * SEPARATE from StylistsController on purpose. That one owns rows in THIS
 * service's database: created here, edited here, deleted here. This one is a
 * read-only window onto staff_profile in the platform service, fetched over
 * gRPC. Same word, two different things, and one controller holding both
 * would make it impossible to tell which id a caller is holding.
 *
 * No access decorator, so the global guard applies: any valid bearer token
 * gets through, customer or staff. NOT @DeskOnly -- this is the list a
 * customer reads to choose who cuts their hair, and the handler already
 * filters to active staff for exactly that reason.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';

import type { Stylist } from '@application/ports/staff-directory.port';
import { ListStylistsQuery } from '@application/queries/list-stylists.query';

/**
 * A DTO, not bare @Query args: this codebase has no @ApiQuery anywhere, so a
 * bare @Query publishes no parameters in /docs and a generated client cannot
 * call the route. The global pipe also runs whitelist:true, so an
 * undecorated field is silently stripped and arrives as undefined, with no
 * error anywhere.
 *
 * @IsString, NOT @IsUUID, even though the columns are uuid. class-validator
 * defers to validator.js, whose 'all' pattern enforces the RFC variant
 * nibble: the fourth group must begin with 8, 9, a or b. The fixture ids
 * this stack runs on (11111111-1111-1111-1111-111111111111 and the 2s) do
 * not, so @IsUUID answers 400 on the exact tenant and branch platform is
 * serving. Found by running it, not by reading it.
 */
export class ListStaffDirectoryDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  @IsString()
  tenantId!: string;

  @ApiProperty({ example: '22222222-2222-2222-2222-222222222222' })
  @IsString()
  branchId!: string;
}

@ApiTags('staff-directory')
@Controller('staff-directory')
export class StaffDirectoryController {
  constructor(private readonly queryBus: QueryBus) {}

  // Single-quoted literal path, for route-order.spec.ts. This controller has
  // no ':id' route, so nothing here can shadow anything.
  @Get('stylists')
  @ApiOperation({
    summary: 'Stylists at a branch, from the platform service',
    description:
      'Read only. rating, reviewCount, yearsExperience, offday, openingTime, ' +
      'closingTime and bio are NULL today: platform has no column for them. ' +
      'The app must HIDE a null field, never render it as 0 or empty.',
  })
  @ApiOkResponse({ description: 'The list, possibly empty.' })
  async list(
    @Query() query: ListStaffDirectoryDto,
  ): Promise<{ stylists: Stylist[] }> {
    const stylists = await this.queryBus.execute<ListStylistsQuery, Stylist[]>(
      new ListStylistsQuery(query.tenantId, query.branchId),
    );
    return { stylists };
  }
}
