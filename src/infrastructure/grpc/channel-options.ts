/**
 * Keepalive for every gRPC channel this service opens.
 *
 * THE PROBLEM. Clients are created at boot and held forever. Nothing
 * between us and platform is obliged to keep an idle TCP connection open,
 * and nothing tells us when one is dropped -- a NAT table expires, a load
 * balancer reaps an idle flow, and the socket is gone with no FIN we ever
 * see. The channel still looks connected. The next real request discovers
 * it, fails with ECONNRESET as UNAVAILABLE, and the retry succeeds because
 * by then the channel has reconnected. A customer paid for that discovery.
 *
 * Keepalive makes the channel prove itself on a timer instead: a ping every
 * `keepalive_time_ms`, an answer required within `keepalive_timeout_ms`, and
 * `permit_without_calls` so it happens while idle -- which is the only time
 * it matters, since a busy connection is being proven by its own traffic.
 *
 * ---------------------------------------------------------------------
 * THE INTERVAL IS A PROPERTY OF THE PEER, NOT OF THIS CODE
 *
 * A gRPC server does not accept whatever ping rate a client chooses. The
 * C-core default -- which grpcio-python inherits -- is
 *
 *   grpc.http2.min_ping_interval_without_data_ms = 300000   (5 minutes)
 *   grpc.http2.max_ping_strikes                  = 2
 *
 * A client pinging more often than that WHILE IDLE earns a strike, and on
 * the second the server sends GOAWAY with ENHANCE_YOUR_CALM and kills the
 * connection. Against a server on defaults, a 30s keepalive therefore
 * causes exactly the failure this file exists to prevent, on a schedule,
 * and it looks identical to the original bug. That is the trap.
 *
 * MEASURED, NOT ASSUMED. Against platform-api with
 * GRPC_KEEPALIVE_TIME_MS=10000 and GRPC_TRACE=keepalive: 11 pings at 10s
 * intervals across ~110s of idle, 11 responses, zero GOAWAY, and the
 * channel still served a booking afterwards. This peer is not on the
 * default floor, so 30s is comfortable and 5 minutes would have been
 * needlessly slow to detect a dead channel.
 *
 * That measurement is of the DEV peer. If production puts a proxy or load
 * balancer in front of platform, the floor is whatever that intermediary
 * enforces, not what platform does. The symptom is unmistakable in the log
 * -- GOAWAY / ENHANCE_YOUR_CALM / too_many_pings, on a regular cadence --
 * and the fix is to raise GRPC_KEEPALIVE_TIME_MS, which is why this is an
 * env var and not a constant.
 *
 * Keepalive is not a complete answer on its own, which is why the adapters
 * also retry UNAVAILABLE once. Keepalive shrinks the window in which a
 * dead channel goes unnoticed; the retry covers what is left in it.
 */

function ms(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // A malformed value must not silently become 0 -- `keepalive_time_ms: 0`
  // is not "off", it is "ping constantly", which is the GOAWAY above.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Channel options shared by every platform client.
 *
 * Passed through Nest's `options.channelOptions`, which hands them to
 * grpc-js untouched, so these are the C-core argument names verbatim.
 */
export function platformChannelOptions(): Record<string, number> {
  return {
    'grpc.keepalive_time_ms': ms('GRPC_KEEPALIVE_TIME_MS', 30_000),
    'grpc.keepalive_timeout_ms': ms('GRPC_KEEPALIVE_TIMEOUT_MS', 10_000),

    // 1, not true. These are C-core ints; a boolean is not accepted.
    'grpc.keepalive_permit_without_calls': 1,
  };
}
