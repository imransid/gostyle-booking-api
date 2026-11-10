import { join } from 'path';
import type { GrpcOptions } from '@nestjs/microservices';

import { platformGrpcAddress } from './staff-grpc.constants';
import { platformChannelOptions } from './channel-options';

/** Injection token for the raw gRPC client the intake adapter wraps.
 *  Handlers never see it: they ask for the POS_TICKET_INTAKE port. */
export const POS_BOOKING_INTAKE_CLIENT = 'POS_BOOKING_INTAKE_CLIENT';

/**
 * The client options for platform's PosBookingIntake (pos_booking.proto).
 *
 * HERE, NOT INLINE in the module, so pos-booking-proto.spec.ts loads the
 * proto with the options the client really uses rather than a copy of them.
 *
 * The same server as the directories and the journal: platformGrpcAddress.
 */
export function posBookingIntakeClientOptions() {
  return {
    // Must match the `package` line in pos_booking.proto exactly.
    package: 'gostyle.pos.booking.v1',
    protoPath: join(process.cwd(), 'proto/pos_booking.proto'),
    url: platformGrpcAddress(),
    channelOptions: platformChannelOptions(),
    loader: {
      // keepCase: true is NOT optional -- every field is snake_case and
      // would otherwise read undefined, and an undefined ticket_id is a
      // ticket nobody can find.
      keepCase: true,
      // `replayed: false` arrives as false, an empty list as [].
      defaults: true,
      // Money is int32 in this proto; Number keeps any later int64 a number.
      longs: Number,
      enums: String,
      oneofs: true,
    },
  } satisfies GrpcOptions['options'];
}
