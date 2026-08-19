import { Observable } from 'rxjs';

export interface VerifyConsumerRequest {
  token: string;
}

export interface VerifyConsumerResponse {
  valid: boolean;
  // Note: snake_case in the proto becomes camelCase here. proto-loader
  // converts by default (keepCase: false).
  consumerId: string;
  verified: boolean;
}

export interface ConsumerAuthClient {
  // Returns an Observable, not a Promise. That is Nest's gRPC convention;
  // callers use firstValueFrom() to await it.
  verifyConsumer(
    request: VerifyConsumerRequest,
  ): Observable<VerifyConsumerResponse>;
}
