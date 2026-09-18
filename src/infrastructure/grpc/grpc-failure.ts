import { status } from '@grpc/grpc-js';

/**
 * Did a gRPC call fail because the server is DOWN, because it broke while
 * answering, or because we asked it something wrong?
 *
 * The three need different words to an operator. "Unavailable" means wait
 * for the dependency to come back; a bug in the request or a proto mismatch
 * means waiting forever, because nothing is coming back on its own.
 * Reporting the second as the first is how an afternoon gets spent
 * restarting a service that was never broken.
 *
 * THIS LIVED IN src/auth/consumer-auth-failure.ts, written for the consumer
 * auth client. Nothing in it was ever about consumer auth: it is a status
 * code in and a judgement out. The services and staff directories need the
 * same judgement -- to decide what is worth retrying, and what is a 503
 * rather than an empty answer -- and a second copy of a taxonomy is a
 * taxonomy that drifts. consumer-auth-failure.ts now names these.
 *
 * Pure on purpose: no Nest, no client, no logger.
 */

/**
 * The codes that mean THE ANSWER NEVER ARRIVED.
 *
 * UNAVAILABLE is what grpc-js reports for ECONNREFUSED, ECONNRESET, a DNS
 * failure and a refused TLS handshake alike -- the connection did not
 * happen, or died before the server saw the request.
 * DEADLINE_EXCEEDED is the same outcome from our side: something is
 * listening and it is not answering, so we have no verdict either way.
 */
const UNREACHABLE: ReadonlySet<number> = new Set<number>([
  status.UNAVAILABLE,
  status.DEADLINE_EXCEEDED,
]);

/**
 * The codes that mean the dependency BROKE WHILE ANSWERING.
 *
 * Distinct from UNREACHABLE: something was listening, it accepted the call,
 * and then it failed. Production case --
 *
 *   2 UNKNOWN: Exception calling application: consuming input failed:
 *   server closed the connection unexpectedly
 *
 * which is a Python gRPC server surfacing a psycopg error: the upstream's
 * own database connection dropped mid-call.
 *
 * These are someone's bug -- but not OURS, and a bare 500 saying "Something
 * went wrong" sends whoever is on call to read this codebase for a database
 * that fell over in another one. So they are a 503 that NAMES the
 * dependency and carries the gRPC status.
 *
 * UNIMPLEMENTED and INVALID_ARGUMENT stay out: a missing method is a deploy
 * skew and a rejected argument is a malformed request, and both really are
 * ours to fix.
 */
const UPSTREAM_FAULT: ReadonlySet<number> = new Set<number>([
  status.UNKNOWN,
  status.INTERNAL,
  status.RESOURCE_EXHAUSTED,
  status.ABORTED,
  status.DATA_LOSS,
]);

/** A gRPC error as grpc-js throws it: a numeric `code`, and usually details. */
interface GrpcError {
  readonly code?: unknown;
  readonly details?: unknown;
  readonly message?: unknown;
}

/** The numeric gRPC status, or null when this is not a gRPC error at all. */
export function grpcStatusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as GrpcError).code;
  return typeof code === 'number' ? code : null;
}

/**
 * True only for a code that is KNOWN to mean the server was not reached.
 *
 * An error carrying no gRPC code at all is not one: it came from our side
 * of the wire (a client that never initialised, an empty observable, an
 * rxjs timeout) and is a bug in this service, which should surface as one.
 */
export function isUnreachable(e: unknown): boolean {
  const code = grpcStatusOf(e);
  return code !== null && UNREACHABLE.has(code);
}

export function isUpstreamFault(e: unknown): boolean {
  const code = grpcStatusOf(e);
  return code !== null && UPSTREAM_FAULT.has(code);
}

/** Anything the dependency is answerable for, reachable or not. */
export function isTransportFailure(e: unknown): boolean {
  return isUnreachable(e) || isUpstreamFault(e);
}

/**
 * Is it safe to send this call again?
 *
 * ONLY UNAVAILABLE. That status means the request never reached the server
 * -- refused, reset, or the channel was already dead -- so repeating it
 * cannot duplicate work that already happened.
 *
 * DEADLINE_EXCEEDED is deliberately NOT here even though it sits beside
 * UNAVAILABLE above. A deadline says we stopped waiting; it says nothing
 * about whether the server acted. Retrying it can run the call twice. The
 * two are grouped for REPORTING, where both mean "no verdict", and
 * separated for RETRYING, where only one is safe.
 */
export function isRetriable(e: unknown): boolean {
  return grpcStatusOf(e) === status.UNAVAILABLE;
}

/** The gRPC status as a name, for `details` on a 503. */
export function grpcStatusName(e: unknown): string | null {
  const code = grpcStatusOf(e);
  return code === null ? null : (status[code] ?? `code ${code}`);
}

/** One line for the log: the code by name, then whatever the server said. */
export function describeGrpcFailure(e: unknown): string {
  const code = grpcStatusOf(e);
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
