import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthService } from './auth.service';
import { TokenVerifier } from './token-verifier.service';
import { CONSUMER_AUTH, consumerGrpcAddress } from './auth.constants';
import { platformChannelOptions } from '@infrastructure/grpc/channel-options';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: CONSUMER_AUTH,
        transport: Transport.GRPC,
        options: {
          package: 'gostyle.auth.v1',
          protoPath: join(process.cwd(), 'proto/auth.proto'),
          url: consumerGrpcAddress(),
          // Clients are made at boot and held forever, so an idle
          // connection dropped by a NAT or a load balancer is only
          // discovered by a real request failing. See channel-options.ts.
          channelOptions: platformChannelOptions(),
          loader: {
            defaults: true,
          },
        },
      },
    ]),
  ],
  providers: [AuthService, TokenVerifier],
  exports: [AuthService, TokenVerifier],
})
export class AuthModule {}
