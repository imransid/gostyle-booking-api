import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthService } from './auth.service';
import { TokenVerifier } from './token-verifier.service';
import { CONSUMER_AUTH, consumerGrpcAddress } from './auth.constants';

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
