import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import {
  SERVICES_DIRECTORY,
  type ServicesDirectoryReader,
  type CatalogueService,
} from '../ports/services-directory.port';
import { ListServicesQuery } from './list-services.query';

/**
 * The service menu for the customer app.
 *
 * A THIN handler on purpose: there is no rule to apply here. Platform
 * already filters to PUBLISHED, to this branch, and to the category, so
 * filtering again here would be two places to change and one would lag.
 *
 * The moment a real rule appears (hide services with no price, sort by
 * popularity) it belongs in the domain layer, not inline here.
 */
@QueryHandler(ListServicesQuery)
export class ListServicesHandler implements IQueryHandler<
  ListServicesQuery,
  CatalogueService[]
> {
  constructor(
    @Inject(SERVICES_DIRECTORY)
    private readonly directory: ServicesDirectoryReader,
  ) {}

  async execute(query: ListServicesQuery): Promise<CatalogueService[]> {
    return this.directory.listServices(
      query.tenantId,
      query.branchId,
      query.categoryId,
    );
  }
}
