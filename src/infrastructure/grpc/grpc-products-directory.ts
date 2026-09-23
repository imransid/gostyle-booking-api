import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { bookingError } from '@application/contract/errors';
import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import {
  describeGrpcFailure,
  grpcStatusName,
  grpcStatusOf,
  isTransportFailure,
} from './grpc-failure';
import { platformGrpcAddress } from './staff-grpc.constants';

import type {
  ProductsDirectoryReader,
  CatalogueProduct,
} from '@application/ports/products-directory.port';
import { PRODUCTS_DIRECTORY_CLIENT } from './products-grpc.constants';

/**
 * The wire shape, snake_case, exactly as products.proto declares it.
 * DECLARED HERE AND NOWHERE ELSE. Optional because proto3 omits defaults.
 */
interface ProductVariantWire {
  variant_id?: string;
  product_id?: string;
  product_name?: string;
  variant_name?: string;
  sku?: string;
  price_minor?: number;
  currency?: string;
  image_url?: string;
  category_name?: string;
  tracked?: boolean;
  available?: number;
}

/** The generated client surface. Nest lowercases the first letter of each rpc. */
interface ProductsDirectoryGrpc {
  listProducts(
    data: { tenant_id: string; branch_id: string; variant_ids: string[] },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<{ variants?: ProductVariantWire[] }>;
}

/** Milliseconds. gRPC sets NO default deadline. */
const CALL_TIMEOUT_MS = 5_000;

@Injectable()
export class GrpcProductsDirectory
  implements ProductsDirectoryReader, OnModuleInit
{
  private readonly logger = new Logger(GrpcProductsDirectory.name);
  private svc!: ProductsDirectoryGrpc;

  constructor(
    @Inject(PRODUCTS_DIRECTORY_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc =
      this.client.getService<ProductsDirectoryGrpc>('ProductsDirectory');
  }

  async listProducts(
    tenantId: string,
    branchId: string,
    variantIds: readonly string[],
  ): Promise<CatalogueProduct[]> {
    try {
      const res = await callWithRetry(
        this.logger,
        `listProducts tenant=${tenantId} branch=${branchId} variants=${variantIds.length}`,
        CALL_TIMEOUT_MS,
        (md, opts) =>
          this.svc.listProducts(
            {
              tenant_id: tenantId,
              branch_id: branchId,
              variant_ids: [...variantIds],
            },
            md,
            opts,
          ),
      );
      return (res.variants ?? []).map(toCatalogueProduct);
    } catch (err) {
      // AN EMPTY LIST MEANS EMPTY -- see grpc-services-directory.ts. A
      // failure is reported as a failure, never as "no such product".
      this.logger.error(
        `listProducts failed for tenant ${tenantId} branch ${branchId}: ` +
          describeGrpcFailure(err),
      );

      if (isTransportFailure(err)) {
        throw bookingError(
          'DEPENDENCY_UNAVAILABLE',
          'The product catalogue is unavailable, so this booking cannot be ' +
            'priced. Nothing was charged. Try again shortly.',
          {
            dependency: 'platform-api ProductsDirectory',
            address: platformGrpcAddress(),
            grpcStatus: grpcStatusName(err),
          },
        );
      }

      // Platform's answer for a branch outside this tenant. The caller's
      // mistake, not ours, so not a bare 500.
      if (grpcStatusOf(err) === status.NOT_FOUND) {
        throw bookingError(
          'BOOKING_NOT_FOUND',
          'That salon is not a branch of this tenant, so its products ' +
            'cannot be priced.',
          { dependency: 'platform-api ProductsDirectory', branchId },
        );
      }
      throw err;
    }
  }
}

/** Wire -> port. The ONLY place snake_case becomes camelCase. */
function toCatalogueProduct(row: ProductVariantWire): CatalogueProduct {
  return {
    variantId: row.variant_id ?? '',
    productId: row.product_id ?? '',
    productName: row.product_name ?? '',
    variantName: row.variant_name ?? '',
    sku: row.sku ?? '',
    priceMinor: row.price_minor ?? 0,
    currency: row.currency ?? '',
    imageUrl: row.image_url || null,
    categoryName: row.category_name || null,
    tracked: row.tracked ?? false,
    available: row.available ?? 0,
  };
}
