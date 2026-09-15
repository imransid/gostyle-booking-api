export class ListServicesQuery {
  constructor(
    readonly tenantId: string,
    readonly branchId: string,
    readonly categoryId?: string,
  ) {}
}
