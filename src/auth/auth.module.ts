import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthService } from './auth.service';
import { TokenVerifier } from './token-verifier.service';

export const CONSUMER_AUTH = 'CONSUMER_AUTH';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: CONSUMER_AUTH,
        transport: Transport.GRPC,
        options: {
          package: 'gostyle.auth.v1',
          protoPath: join(process.cwd(), 'proto/auth.proto'),
          url: process.env.CONSUMER_GRPC_ADDR ?? 'localhost:50051',
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
