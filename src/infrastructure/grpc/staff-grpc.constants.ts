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
