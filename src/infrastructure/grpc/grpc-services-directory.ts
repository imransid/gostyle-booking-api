import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { bookingError } from '@application/contract/errors';
import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import {
  describeGrpcFailure,
  grpcStatusName,
  isTransportFailure,
} from './grpc-failure';
import { platformGrpcAddress } from './staff-grpc.constants';

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
  listServices(
    data: {
      tenant_id: string;
      branch_id: string;
      category_id: string;
    },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<{ services?: ServiceWire[] }>;
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
      const res = await callWithRetry(
        this.logger,
        `listServices tenant=${tenantId} branch=${branchId}`,
        CALL_TIMEOUT_MS,
        (md, opts) =>
          this.svc.listServices(
            {
              tenant_id: tenantId,
              branch_id: branchId,
              category_id: categoryId ?? '',
            },
            md,
            opts,
          ),
      );
      return (res.services ?? []).map(toCatalogueService);
    } catch (err) {
      /**
       * AN EMPTY LIST MEANS EMPTY. It does not mean "we could not ask".
       *
       * This used to return [] on any failure, described as closed by
       * default: platform did not answer, so this service knows of no
       * services. That reasoning holds for a panel on a busy screen. It
       * does not hold here, because this answer PRICES A BOOKING. A
       * catalogue that comes back empty because a server fell over makes
       * the caller's own service id unfindable, and the customer is told
       * `unknown_service` -- that the thing they are trying to book does
       * not exist. They then go and look for it, or give up. Nobody is
       * told a server is down, and nothing in the log says a customer was
       * turned away rather than a panel left blank.
       *
       * So the failure is reported as a failure. A transport fault becomes
       * a 503 that NAMES the dependency, which is the difference between
       * an operator paging platform and an operator reading this codebase.
       * Anything else -- UNIMPLEMENTED from a deploy skew, INVALID_ARGUMENT
       * from a malformed request -- is ours, and is re-thrown untouched so
       * it surfaces as the 500 it is rather than a 503 telling someone to
       * wait for a fix nobody is making.
       */
      this.logger.error(
        `listServices failed for tenant ${tenantId}: ${describeGrpcFailure(err)}`,
      );

      if (isTransportFailure(err)) {
        throw bookingError(
          'DEPENDENCY_UNAVAILABLE',
          'The service catalogue is unavailable, so this booking cannot be ' +
            'priced. Nothing was charged. Try again shortly.',
          {
            dependency: 'platform-api ServicesDirectory',
            address: platformGrpcAddress(),
            grpcStatus: grpcStatusName(err),
          },
        );
      }
      throw err;
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
