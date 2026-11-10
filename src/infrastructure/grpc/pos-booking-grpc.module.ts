import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { POS_TICKET_INTAKE } from '@application/ports/pos-ticket-intake.port';
import { GrpcPosBookingIntake } from './grpc-pos-booking-intake';
import {
  POS_BOOKING_INTAKE_CLIENT,
  posBookingIntakeClientOptions,
} from './pos-booking-grpc.constants';

/**
 * Wires the POS_TICKET_INTAKE port to platform's PosBookingIntake, for the
 * pos_ticket_sync worker. THIS MODULE IS THE ONLY PLACE THE TWO MEET.
 *
 * Keyed with PLATFORM_INTERNAL_KEY, like FloorGrpcModule. Unlike it, every
 * call is idempotent, so it goes through callWithRetry.
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: POS_BOOKING_INTAKE_CLIENT,
        transport: Transport.GRPC,
        options: posBookingIntakeClientOptions(),
      },
    ]),
  ],
  providers: [{ provide: POS_TICKET_INTAKE, useClass: GrpcPosBookingIntake }],
  exports: [POS_TICKET_INTAKE],
})
export class PosBookingGrpcModule {}
