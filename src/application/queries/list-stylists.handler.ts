import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import {
  STAFF_DIRECTORY,
  type StaffDirectoryReader,
  type Stylist,
} from '../ports/staff-directory.port';
import { ListStylistsQuery } from './list-stylists.query';

/**
 * The stylist list for the customer app.
 *
 * A THIN handler on purpose: there is no rule to apply here. It asks the
 * port and filters to the people a customer should see. The moment a real
 * rule appears (hide staff with no bookable skills, sort by rating) it
 * belongs in the domain layer, not inline here.
 */
@QueryHandler(ListStylistsQuery)
export class ListStylistsHandler implements IQueryHandler<
  ListStylistsQuery,
  Stylist[]
> {
  constructor(
    @Inject(STAFF_DIRECTORY) private readonly directory: StaffDirectoryReader,
  ) {}

  async execute(query: ListStylistsQuery): Promise<Stylist[]> {
    const all = await this.directory.listStylists(
      query.tenantId,
      query.branchId,
    );

    // ACTIVE only, and this filter lives HERE rather than in the adapter.
    // The wire deliberately carries every employment status so each caller
    // decides: an ops screen wants to see someone on leave, a customer
    // picking a stylist to book must not.
    return all.filter((s) => s.active);
  }
}
