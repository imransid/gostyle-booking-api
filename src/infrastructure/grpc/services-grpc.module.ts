import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { SERVICES_DIRECTORY } from '@application/ports/services-directory.port';
import { GrpcServicesDirectory } from './grpc-services-directory';
import { SERVICES_DIRECTORY_CLIENT } from './services-grpc.constants';
import { platformGrpcAddress } from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the services directory port to its gRPC adapter.
 *
 * THIS MODULE IS THE ONLY PLACE THE TWO MEET. Everything above imports
 * the port; only this file knows GrpcServicesDirectory exists.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: SERVICES_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: {
          // Must match the `package` line in services.proto exactly.
          package: 'gostyle.services.v1',
          protoPath: join(process.cwd(), 'proto/services.proto'),
          url: platformGrpcAddress(),
          // Clients are made at boot and held forever, so an idle
          // connection dropped by a NAT or a load balancer is only
          // discovered by a real request failing. See channel-options.ts.
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: true is NOT optional. Platform sets it, so fields
            // arrive as service_id. Without it here, proto-loader renames
            // them to serviceId and every snake_case read in the adapter
            // returns undefined, with no error on either side.
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
  providers: [{ provide: SERVICES_DIRECTORY, useClass: GrpcServicesDirectory }],
  exports: [SERVICES_DIRECTORY],
})
export class ServicesGrpcModule {}
