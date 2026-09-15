/**
 * Services AS PLATFORM KNOWS THEM, for the customer app.
 *
 * Read-only window onto platform's service catalogue over gRPC. This
 * service owns no service rows of its own.
 *
 * NOT the same as GET /availability/catalogue, which returns the fixture
 * menu the availability engine runs on. Different ids, different source.
 * Do not mix them.
 *
 * No access decorator, so the global guard applies: any valid bearer
 * token gets through, customer or staff. This is the menu a customer
 * reads to choose what to book.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import type { CatalogueService } from '@application/ports/services-directory.port';
import { ListServicesQuery } from '@application/queries/list-services.query';

/**
 * A DTO, not bare @Query args: this codebase has no @ApiQuery anywhere,
 * so a bare @Query publishes no parameters in /docs and a generated
 * client cannot call the route. The global pipe also runs whitelist:true,
 * so an undecorated field is silently stripped and arrives as undefined.
 *
 * @IsString, NOT @IsUUID. validator.js enforces the RFC variant nibble,
 * and the fixture ids this stack runs on (1111..., 2222...) fail it —
 * @IsUUID would answer 400 on the exact tenant platform is serving.
 */
export class ListServicesDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  @IsString()
  tenantId!: string;

  @ApiProperty({ example: '22222222-2222-2222-2222-222222222222' })
  @IsString()
  branchId!: string;

  @ApiPropertyOptional({
    example: '55555555-5555-5555-5555-555555555552',
    description: 'Omit for every category.',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;
}

@ApiTags('services-directory')
@Controller('services-directory')
export class ServicesDirectoryController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get('services')
  @ApiOperation({
    summary: 'Services a branch offers, from the platform service',
    description:
      'Read only. PUBLISHED services available at this branch. ' +
      'photoUrls and includedSteps may be empty. ' +
      'The app must HIDE an empty field, never render it as 0 or blank.',
  })
  @ApiOkResponse({ description: 'The list, possibly empty.' })
  async list(
    @Query() query: ListServicesDto,
  ): Promise<{ services: CatalogueService[] }> {
    const services = await this.queryBus.execute<
      ListServicesQuery,
      CatalogueService[]
    >(new ListServicesQuery(query.tenantId, query.branchId, query.categoryId));
    return { services };
  }
}
