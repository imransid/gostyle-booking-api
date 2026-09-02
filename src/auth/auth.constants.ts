export const CONSUMER_AUTH = 'CONSUMER_AUTH';

/**
 * Where the consumer API answers gRPC.
 *
 * Read through here by everyone: the client dials it, the health rail reports
 * it, the 503's log line names it. A second copy of the default would let an
 * operator read "unreachable at localhost:50051" while the client was in fact
 * dialling 10.0.1.250 -- a wrong box to go and check, printed with total
 * confidence. A function, not a const, so it reads the environment when asked
 * rather than at import time.
 */
export const consumerGrpcAddress = (): string =>
  process.env.CONSUMER_GRPC_ADDR ?? 'localhost:50051';
