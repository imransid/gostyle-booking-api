import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { PRODUCTS_DIRECTORY } from '@application/ports/products-directory.port';
import { GrpcProductsDirectory } from './grpc-products-directory';
import { PRODUCTS_DIRECTORY_CLIENT } from './products-grpc.constants';
import { platformGrpcAddress } from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the products directory port to its gRPC adapter.
 *
 * THIS MODULE IS THE ONLY PLACE THE TWO MEET.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: PRODUCTS_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: {
          // Must match the `package` line in products.proto exactly.
          package: 'gostyle.products.v1',
          protoPath: join(process.cwd(), 'proto/products.proto'),
          url: platformGrpcAddress(),
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: true is NOT optional -- see services-grpc.module.ts.
            keepCase: true,
            defaults: true,
            longs: String,
            enums: String,
            oneofs: true,
          },
        },
      },
    ]),
  ],
  providers: [{ provide: PRODUCTS_DIRECTORY, useClass: GrpcProductsDirectory }],
  exports: [PRODUCTS_DIRECTORY],
})
export class ProductsGrpcModule {}
