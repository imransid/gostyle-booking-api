import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import type { Client } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { CONSUMER_AUTH, consumerGrpcAddress } from './auth.constants';
import { ConsumerAuthClient, VerifyConsumerResponse } from './auth.interface';

export interface Identity {
  consumerId: string;
  verified: boolean;
}

/** What the health rail reports about the customer auth dependency. */
export interface ConsumerAuthProbe {
  readonly reachable: boolean;
  readonly address: string;
  readonly latencyMs: number | null;
  readonly error?: string;
}

/**
 * How long the probe waits for a connection before calling it unreachable.
 *
 * Paid in full on every health check while the consumer API is down, because
 * grpc-js keeps retrying until the deadline. Docker Swarm's health check has
 * its own timeout and the database ping shares the same request, so this stays
 * short: an operator learns "unreachable" a second sooner and a slow answer
 * would be indistinguishable from an unhealthy container.
 */
const PROBE_TIMEOUT_MS = 750;

/** The SERVICE name from the proto, not the package. */
const CONSUMER_AUTH_SERVICE = 'ConsumerAuth';

@Injectable()
export class AuthService implements OnModuleInit {
  private client: ConsumerAuthClient;

  constructor(@Inject(CONSUMER_AUTH) private readonly grpc: ClientGrpc) {}

  // getService() cannot run in the constructor: the gRPC client is not
  // connected yet at that point. OnModuleInit fires after Nest has wired
  // everything, which is the earliest safe moment.
  onModuleInit() {
    this.client = this.grpc.getService<ConsumerAuthClient>(
      CONSUMER_AUTH_SERVICE,
    );
  }

  /**
   * Returns null for a bad token, which is an ORDINARY answer.
   *
   * A thrown gRPC error means the call itself failed (customer-api down,
   * network gone) and is deliberately left to propagate. Catching it and
   * returning null would report an outage as an auth failure, which is the
   * kind of bug that wastes a day. TokenVerifier catches it one layer up and
   * turns it into a 503 that says which dependency.
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

  /**
   * Can we reach the consumer API right now?
   *
   * Connects, and asks nothing. waitForReady drives the real channel -- DNS,
   * TCP, TLS -- so a refused connection is found the same way a token
   * verification would find it, without inventing a token to send or writing
   * a request into someone's auth log every time Swarm checks this container.
   *
   * NEVER REJECTS. The health endpoint reports rails; a probe that threw
   * would take the whole response down with it and hide the database rail
   * behind the failure of this one.
   */
  async probe(): Promise<ConsumerAuthProbe> {
    const address = consumerGrpcAddress();
    const started = Date.now();

    let client: Client;
    try {
      client = this.grpc.getClientByServiceName<Client>(CONSUMER_AUTH_SERVICE);
    } catch (e) {
      // The client could not even be built: a missing proto or a service name
      // that is not in it. Ours to fix, not the dependency's, and the message
      // says which.
      return {
        reachable: false,
        address,
        latencyMs: null,
        error: e instanceof Error ? e.message : 'gRPC client unavailable',
      };
    }

    return new Promise<ConsumerAuthProbe>((resolve) => {
      client.waitForReady(Date.now() + PROBE_TIMEOUT_MS, (e?: Error) => {
        const latencyMs = Date.now() - started;
        resolve(
          e === undefined
            ? { reachable: true, address, latencyMs }
            : {
                reachable: false,
                address,
                latencyMs,
                error: e.message,
              },
        );
      });
    });
  }
}
