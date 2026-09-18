/**
 * The consumer auth client's names for the shared gRPC failure taxonomy.
 *
 * The logic moved to infrastructure/grpc/grpc-failure.ts when the services
 * and staff directories needed the same judgement. Nothing in it was ever
 * specific to consumer auth -- it is a status code in and a judgement out
 * -- and two copies of a taxonomy is a taxonomy that drifts.
 *
 * These names are kept because token-verifier.service.ts reads better with
 * them: `isConsumerAuthTheirFault(e)` says which dependency is being judged
 * at a call site that judges exactly one.
 */
export {
  isUnreachable as isConsumerAuthUnreachable,
  isUpstreamFault as isConsumerAuthFaulted,
  isTransportFailure as isConsumerAuthTheirFault,
  grpcStatusName as consumerAuthStatusName,
  describeGrpcFailure as describeConsumerAuthFailure,
} from '@infrastructure/grpc/grpc-failure';
