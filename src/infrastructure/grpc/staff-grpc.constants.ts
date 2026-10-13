import { join } from 'path';
import type { GrpcOptions } from '@nestjs/microservices';

import { platformChannelOptions } from './channel-options';

/** Injection token for the raw gRPC client. Not the same as STAFF_DIRECTORY:
 *  that one names the PORT, this one names the transport client the adapter
 *  wraps. Two different things, so two different tokens. */
export const STAFF_DIRECTORY_CLIENT = 'STAFF_DIRECTORY_CLIENT';

/**
 * Where platform-api answers gRPC.
 *
 * `platform-api` is the alias on the shared gostyle-net network, not a
 * container name (those carry a replica suffix) and not localhost (which
 * inside this container means this container).
 *
 * From env so it changes per environment without a code change.
 */
export function platformGrpcAddress(): string {
  return process.env.PLATFORM_GRPC_ADDR ?? 'platform-api:50052';
}

/**
 * The client options for platform's StaffDirectory (staff.proto).
 *
 * HERE, NOT INLINE in staff-grpc.module.ts, so the live spec
 * (grpc-staff-directory.live.spec.ts) talks to platform with the options the
 * client really uses rather than a copy of them, as the chair directory's do
 * (floor-grpc.constants.ts).
 */
export function staffDirectoryClientOptions() {
  return {
    // Must match the `package` line in staff.proto exactly.
    package: 'gostyle.staff.v1',
    // process.cwd(), matching the existing auth.module.ts. The Dockerfile
    // does `COPY proto ./proto`, so the file sits at the app root at runtime
    // and is never compiled into dist.
    protoPath: join(process.cwd(), 'proto/staff.proto'),
    url: platformGrpcAddress(),
    // Clients are made at boot and held forever, so an idle connection
    // dropped by a NAT or a load balancer is only discovered by a real
    // request failing. See channel-options.ts.
    channelOptions: platformChannelOptions(),
    loader: {
      // keepCase: true is NOT optional. The platform server sets it, so
      // fields arrive as first_name. Without it here, proto-loader renames
      // them to firstName and every snake_case read in the adapter returns
      // undefined, with no error on either side.
      //
      // NOTE the existing auth.module.ts does NOT set this. That client talks
      // to a different service whose fields are single words, so the casing
      // never mattered there. Do not copy that omission.
      keepCase: true,
      defaults: true,
      longs: String,
      enums: String,
      oneofs: true,
    },
  } satisfies GrpcOptions['options'];
}
