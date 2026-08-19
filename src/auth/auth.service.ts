import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { CONSUMER_AUTH } from './auth.constants';
import { ConsumerAuthClient, VerifyConsumerResponse } from './auth.interface';

export interface Identity {
  consumerId: string;
  verified: boolean;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private client: ConsumerAuthClient;

  constructor(@Inject(CONSUMER_AUTH) private readonly grpc: ClientGrpc) {}

  // getService() cannot run in the constructor: the gRPC client is not
  // connected yet at that point. OnModuleInit fires after Nest has wired
  // everything, which is the earliest safe moment.
  onModuleInit() {
    // 'ConsumerAuth' is the SERVICE name from the proto, not the package.
    this.client = this.grpc.getService<ConsumerAuthClient>('ConsumerAuth');
  }

  /**
   * Returns null for a bad token, which is an ORDINARY answer.
   *
   * A thrown gRPC error means the call itself failed (customer-api down,
   * network gone) and is deliberately left to propagate. Catching it and
   * returning null would report an outage as an auth failure, which is the
   * kind of bug that wastes a day.
   */
  async verifyToken(token: string): Promise<Identity | null> {
    const reply: VerifyConsumerResponse = await firstValueFrom(
      this.client.verifyConsumer({ token }),
    );

    if (!reply.valid) {
      return null;
    }

    return { consumerId: reply.consumerId, verified: reply.verified };
  }
}
