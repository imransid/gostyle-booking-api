import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthService } from './auth.service';

export const CONSUMER_AUTH = 'CONSUMER_AUTH';

@Module({
  imports: [
    ClientsModule.register([
      {
        // This string is the injection token. Anything asking for
        // @Inject(CONSUMER_AUTH) gets this client.
        name: CONSUMER_AUTH,
        transport: Transport.GRPC,
        options: {
          package: 'gostyle.auth.v1',
          protoPath: join(process.cwd(), 'proto/auth.proto'),
          url: process.env.CONSUMER_GRPC_ADDR ?? 'localhost:50051',
          loader: {
            // Proto3 omits default values on the wire, so a `false` bool arrives as
            // `undefined` rather than `false`. This tells proto-loader to fill in the
            // declared defaults, which makes the TypeScript interface honest: every
            // field it claims exists actually exists.
            defaults: true,
          },
        },
      },
    ]),
  ],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
