import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { CHAIR_DIRECTORY } from '@application/ports/chair-directory.port';
import { GrpcChairDirectory } from './grpc-chair-directory';
import {
  CHAIR_DIRECTORY_CLIENT,
  chairDirectoryClientOptions,
} from './floor-grpc.constants';

/**
 * Wires the chair directory port to platform's ChairDirectory, for self
 * check-in at a chair. THIS MODULE IS THE ONLY PLACE THE TWO MEET.
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
  providers: [{ provide: CHAIR_DIRECTORY, useClass: GrpcChairDirectory }],
  exports: [CHAIR_DIRECTORY],
})
export class FloorGrpcModule {}
