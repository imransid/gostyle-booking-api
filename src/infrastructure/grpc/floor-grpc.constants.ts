import { join } from 'path';
import type { GrpcOptions } from '@nestjs/microservices';

import { platformGrpcAddress } from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/** Injection token for the raw gRPC client the chair adapter wraps. Handlers
 *  never see it: they ask for the port. */
export const CHAIR_DIRECTORY_CLIENT = 'CHAIR_DIRECTORY_CLIENT';

/**
 * The client options for platform's ChairDirectory (floor.proto).
 *
 * HERE, NOT INLINE in floor-grpc.module.ts as the other directories have
 * theirs, so floor-proto.spec.ts loads the proto with the options the client
 * really uses rather than a copy of them.
 *
 * The same server as staff, services and products: platformGrpcAddress.
 */
export function chairDirectoryClientOptions() {
  return {
    // Must match the `package` line in floor.proto exactly.
    package: 'gostyle.floor.v1',
    protoPath: join(process.cwd(), 'proto/floor.proto'),
    url: platformGrpcAddress(),
    channelOptions: platformChannelOptions(),
    loader: {
      // keepCase: true is NOT optional -- see staff-grpc.constants.ts. Every
      // field here is snake_case; without it they all read undefined, and an
      // undefined chair_bookable refuses every chair without an error.
      keepCase: true,
      defaults: true,
      longs: String,
      enums: String,
      oneofs: true,
    },
  } satisfies GrpcOptions['options'];
}
