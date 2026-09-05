import { status } from '@grpc/grpc-js';

/**
 * Did this call fail because the consumer API is DOWN, or because it answered
 * badly?
 *
 * The two need different words to an operator. "Unavailable" means wait for
 * the dependency to come back; a bug in the request or a proto mismatch means
 * waiting forever, because nothing is coming back on its own. Reporting the
 * second as the first is how an afternoon gets spent restarting a service
 * that was never broken -- the mirror of the mistake AuthService avoids by
 * refusing to report an outage as a bad token.
 *
 * Pure on purpose: a status code in, a judgement out. No Nest, no client.
 */

/**
 * The codes that mean the answer never arrived.
 *
 * UNAVAILABLE is what grpc-js reports for ECONNREFUSED, a DNS failure and a
 * refused TLS handshake alike -- the connection did not happen.
 * DEADLINE_EXCEEDED is the same outcome from our side: something is listening
 * and it is not answering, so we have no verdict on this token either way.
 *
 * Everything else is deliberately absent. UNIMPLEMENTED means the server is
 * up and does not have the method (a deploy skew), INVALID_ARGUMENT means we
 * sent something wrong, INTERNAL means it broke while answering. All three
 * are bugs someone has to fix, and a 503 would tell the operator to sit and
 * wait for them instead.
 */
const UNREACHABLE: ReadonlySet<number> = new Set<number>([
  status.UNAVAILABLE,
  status.DEADLINE_EXCEEDED,
]);

/** A gRPC error as grpc-js throws it: a numeric `code`, and usually details. */
interface GrpcError {
  readonly code?: unknown;
  readonly details?: unknown;
  readonly message?: unknown;
}

function codeOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as GrpcError).code;
  return typeof code === 'number' ? code : null;
}

/**
 * True only for a code that is KNOWN to mean the dependency is unreachable.
 *
 * An error carrying no gRPC code at all is not one: it came from our side of
 * the wire (a client that never initialised, an empty observable) and is a
 * bug in this service, which should surface as one.
 */
export function isConsumerAuthUnreachable(e: unknown): boolean {
  const code = codeOf(e);
  return code !== null && UNREACHABLE.has(code);
}

/** One line for the log: the code by name, then whatever the server said. */
export function describeConsumerAuthFailure(e: unknown): string {
  const code = codeOf(e);
  const name =
    code === null ? 'no gRPC code' : (status[code] ?? `code ${code}`);
  const detail =
    typeof e === 'object' && e !== null
      ? ((e as GrpcError).details ?? (e as GrpcError).message)
      : e;
  return typeof detail === 'string' && detail !== ''
    ? `${name}: ${detail}`
    : name;
}
