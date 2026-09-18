import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { STAFF_DIRECTORY } from '@application/ports/staff-directory.port';
import { GrpcStaffDirectory } from './grpc-staff-directory';
import {
  STAFF_DIRECTORY_CLIENT,
  platformGrpcAddress,
} from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the staff directory port to its gRPC adapter.
 *
 * THIS MODULE IS THE ONLY PLACE THE TWO MEET. Everything above imports the
 * port; only this file knows GrpcStaffDirectory exists. Swapping to HTTP
 * later means changing the one `useClass` line below.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: STAFF_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: {
          // Must match the `package` line in staff.proto exactly.
          package: 'gostyle.staff.v1',
          // process.cwd(), matching the existing auth.module.ts. The Dockerfile
          // does `COPY proto ./proto`, so the file sits at the app root at
          // runtime and is never compiled into dist.
          protoPath: join(process.cwd(), 'proto/staff.proto'),
          url: platformGrpcAddress(),
          // Clients are made at boot and held forever, so an idle
          // connection dropped by a NAT or a load balancer is only
          // discovered by a real request failing. See channel-options.ts.
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: true is NOT optional. The platform server sets it, so
            // fields arrive as first_name. Without it here, proto-loader
            // renames them to firstName and every snake_case read in the
            // adapter returns undefined, with no error on either side.
            //
            // NOTE the existing auth.module.ts does NOT set this. That client
            // talks to a different service whose fields are single words, so
            // the casing never mattered there. Do not copy that omission.
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
  providers: [
    // The binding. `STAFF_DIRECTORY` is what handlers ask for; the class
    // behind it is an implementation detail they never see.
    { provide: STAFF_DIRECTORY, useClass: GrpcStaffDirectory },
  ],
  exports: [STAFF_DIRECTORY],
})
export class StaffGrpcModule {}
