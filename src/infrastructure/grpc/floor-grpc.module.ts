import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import {
  CHAIR_DIRECTORY_CLIENT,
  chairDirectoryClientOptions,
} from './floor-grpc.constants';

/**
 * Platform's ChairDirectory, for self check-in at a chair.
 *
 * NOT LIKE THE OTHER DIRECTORIES, twice over (floor.proto says both):
 *
 *   keyed         every call carries PLATFORM_INTERNAL_KEY as gRPC metadata
 *                 `x-internal-key`, or platform refuses it UNAUTHENTICATED
 *   not readonly  every call writes one scan row in the salon's registry, so
 *                 it is made once per real scan, with a deadline and never
 *                 through callWithRetry: a retry is a false scan
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: CHAIR_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: chairDirectoryClientOptions(),
      },
    ]),
  ],
})
export class FloorGrpcModule {}
