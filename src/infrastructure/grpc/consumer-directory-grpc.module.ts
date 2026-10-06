import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { CUSTOMER_CONTACT } from '@application/ports/customer-contact.port';
import { consumerGrpcAddress } from '../../auth/auth.constants';
import {
  CONSUMER_DIRECTORY_CLIENT,
  GrpcCustomerContact,
} from './grpc-customer-contact';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the customer contact port to customer-api's ConsumerDirectory.
 *
 * THE SAME SERVER AS CONSUMER AUTH, read through the same consumerGrpcAddress,
 * so the two can never be pointed at different hosts by accident.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: CONSUMER_DIRECTORY_CLIENT,
        transport: Transport.GRPC,
        options: {
          package: 'gostyle.consumer.v1',
          protoPath: join(process.cwd(), 'proto/consumer_directory.proto'),
          url: consumerGrpcAddress(),
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: the fields are snake_case (email_verified, full_name)
            // and the adapter reads them as such. See staff-grpc.module.ts.
            keepCase: true,
            defaults: true,
            longs: String,
            enums: String,
            oneofs: true,
          },
        },
      },
    ]),
  ],
  providers: [{ provide: CUSTOMER_CONTACT, useClass: GrpcCustomerContact }],
  exports: [CUSTOMER_CONTACT],
})
export class ConsumerDirectoryGrpcModule {}
