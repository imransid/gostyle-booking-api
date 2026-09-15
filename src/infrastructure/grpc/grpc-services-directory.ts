import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, timeout, Observable } from 'rxjs';

import type {
  ServicesDirectoryReader,
  CatalogueService,
} from '@application/ports/services-directory.port';
import { SERVICES_DIRECTORY_CLIENT } from './services-grpc.constants';

/**
 * The wire shape, snake_case, exactly as services.proto declares it.
 *
 * DECLARED HERE AND NOWHERE ELSE. This is the only file allowed to know
 * a proto exists; everything above receives `CatalogueService`.
 *
 * Fields are optional because proto3 omits defaults: an empty string is
 * simply not sent, so the key is absent rather than ''. Every read below
 * coalesces.
 */
interface ServiceWire {
  service_id?: string;
  name?: string;
  description?: string;
  price_minor?: number;
  currency?: string;
  duration_minutes?: number;
  category_id?: string;
  category_name?: string;
  photo_urls?: string[];
  included_steps?: string[];
}

/** The generated client surface. Nest lowercases the first letter of each rpc. */
interface ServicesDirectoryGrpc {
  listServices(data: {
    tenant_id: string;
    branch_id: string;
    category_id: string;
  }): Observable<{ services?: ServiceWire[] }>;
}

/** Milliseconds. gRPC sets NO default deadline, so an unanswered call
 *  hangs until the socket dies, holding a request open the whole time. */
const CALL_TIMEOUT_MS = 5_000;

@Injectable()
export class GrpcServicesDirectory
  implements ServicesDirectoryReader, OnModuleInit
{
  private readonly logger = new Logger(GrpcServicesDirectory.name);
  private svc!: ServicesDirectoryGrpc;

  constructor(
    @Inject(SERVICES_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  /** getService in onModuleInit, NOT in the constructor: the client proxy
   *  is not ready until Nest has initialised the module. */
  onModuleInit(): void {
    this.svc =
      this.client.getService<ServicesDirectoryGrpc>('ServicesDirectory');
  }

  async listServices(
    tenantId: string,
    branchId: string,
    categoryId?: string,
  ): Promise<CatalogueService[]> {
    try {
      const res = await firstValueFrom(
        this.svc
          .listServices({
            tenant_id: tenantId,
            branch_id: branchId,
            category_id: categoryId ?? '',
          })
          .pipe(timeout(CALL_TIMEOUT_MS)),
      );
      return (res.services ?? []).map(toCatalogueService);
    } catch (err) {
      // CLOSED BY DEFAULT, the same rule the staff adapter follows.
      // An empty list is honest: platform did not answer, so this service
      // knows of no services. Throwing would take down a whole screen
      // because one panel could not load.
      this.logger.error(
        `listServices failed for tenant ${tenantId}: ${String(err)}`,
      );
      return [];
    }
  }
}

/**
 * Wire -> domain. The ONLY place snake_case becomes camelCase.
 *
 * '' becomes null, not ''. Empty is a proto3 artefact; above this line
 * "no category" must be distinguishable from "a category named nothing".
 */
function toCatalogueService(row: ServiceWire): CatalogueService {
  return {
    id: row.service_id ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    priceMinor: row.price_minor ?? 0,
    currency: row.currency ?? 'AED',
    durationMinutes: row.duration_minutes ?? 0,
    categoryId: row.category_id || null,
    categoryName: row.category_name || null,
    photoUrls: row.photo_urls ?? [],
    includedSteps: row.included_steps ?? [],
  };
}
