import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { STAFF_DIRECTORY } from '@application/ports/staff-directory.port';
import { GrpcStaffDirectory } from './grpc-staff-directory';
import {
  STAFF_DIRECTORY_CLIENT,
  staffDirectoryClientOptions,
} from './staff-grpc.constants';

/**
 * Wires the staff directory port to its gRPC adapter.
 *
 * THIS MODULE IS THE ONLY PLACE THE TWO MEET. Everything above imports the
 * port; only this file knows GrpcStaffDirectory exists. Swapping to HTTP
 * later means changing the one `useClass` line below.
 *
 * The client's options are staffDirectoryClientOptions
 * (staff-grpc.constants.ts), shared with the live spec.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: STAFF_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: staffDirectoryClientOptions(),
      },
    ]),
  ],
  providers: [
    // The binding. `STAFF_DIRECTORY` is what handlers ask for; the class
    // behind it is an implementation detail they never see.
    { provide: STAFF_DIRECTORY, useClass: GrpcStaffDirectory },
  ],
  exports: [STAFF_DIRECTORY],
})
export class StaffGrpcModule {}
