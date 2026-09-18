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

/**
 * The codes that mean the dependency BROKE WHILE ANSWERING.
 *
 * Distinct from UNREACHABLE: something was listening, it accepted the call,
 * and then it failed. Production case --
 *
 *   2 UNKNOWN: Exception calling application: consuming input failed:
 *   server closed the connection unexpectedly
 *
 * which is a Python gRPC server surfacing a psycopg error: the consumer
 * API's own database connection dropped mid-call.
 *
 * THIS FILE ORIGINALLY PUT THESE WITH THE BUGS, and the reasoning was that
 * a 503 tells an operator to wait for a recovery that is not coming. That
 * reasoning was half right. It IS someone's bug -- but not OURS, and a bare
 * 500 saying "Something went wrong" sends whoever is on call to read this
 * codebase for a database that fell over in another one. That is the exact
 * mistake this file exists to prevent, pointed the other way.
 *
 * So these are a 503 that NAMES the dependency and carries the gRPC status,
 * which is what lets an operator tell a blip from a structural fault.
 *
 * UNIMPLEMENTED and INVALID_ARGUMENT stay out: a missing method is a deploy
 * skew and a rejected argument is a malformed request, and both of those
 * really are ours to fix.
 */
const UPSTREAM_FAULT: ReadonlySet<number> = new Set<number>([
  status.UNKNOWN,
  status.INTERNAL,
  status.RESOURCE_EXHAUSTED,
  status.ABORTED,
  status.DATA_LOSS,
]);

export function isConsumerAuthFaulted(e: unknown): boolean {
  const code = codeOf(e);
  return code !== null && UPSTREAM_FAULT.has(code);
}

/** Anything the dependency is answerable for, reachable or not. */
export function isConsumerAuthTheirFault(e: unknown): boolean {
  return isConsumerAuthUnreachable(e) || isConsumerAuthFaulted(e);
}

/** The gRPC status as a name, for `details` on the 503. */
export function consumerAuthStatusName(e: unknown): string | null {
  const code = codeOf(e);
  return code === null ? null : (status[code] ?? `code ${code}`);
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
