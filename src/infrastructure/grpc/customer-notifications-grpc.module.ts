import { join } from 'path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { CUSTOMER_NOTIFIER } from '@application/ports/customer-notifier.port';
import { REMINDER_LEADS } from '@application/ports/reminder-leads.port';
import { consumerGrpcAddress } from '../../auth/auth.constants';
import {
  CUSTOMER_NOTIFICATIONS_CLIENT,
  GrpcCustomerNotifier,
} from './grpc-customer-notifier';
import { platformChannelOptions } from './channel-options';

/**
 * Wires the customer notifier and reminder lead ports to customer-api's
 * CustomerNotifications, on the same server as ConsumerAuth and
 * ConsumerDirectory, read through the same consumerGrpcAddress.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: CUSTOMER_NOTIFICATIONS_CLIENT,
        transport: Transport.GRPC,
        options: {
          package: 'gostyle.consumer.v1',
          protoPath: join(process.cwd(), 'proto/customer_notifications.proto'),
          url: consumerGrpcAddress(),
          channelOptions: platformChannelOptions(),
          loader: {
            // keepCase: snake_case fields, read as such (consumer_id, ...).
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
  providers: [
    GrpcCustomerNotifier,
    { provide: CUSTOMER_NOTIFIER, useExisting: GrpcCustomerNotifier },
    { provide: REMINDER_LEADS, useExisting: GrpcCustomerNotifier },
  ],
  exports: [CUSTOMER_NOTIFIER, REMINDER_LEADS],
})
export class CustomerNotificationsGrpcModule {}
