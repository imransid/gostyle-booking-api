import { Module } from '@nestjs/common';
import { AvailabilityController } from '@interface/http/availability.controller';
import {
  GetAvailabilityHandler,
  GetCatalogueHandler,
} from '@application/queries/get-availability.handler';
import { BOOKING_CONTEXT } from '@application/ports/booking-context.port';
import { HealthController } from '@interface/http/health.controller';

import { HoldsController } from '@interface/http/holds.controller';
import { PlaceHoldHandler } from '@application/commands/place-hold.handler';
import { DbBookingContext } from '@infrastructure/persistence/db-booking-context';

import { BookingsController } from '@interface/http/bookings.controller';
import { ConfirmBookingHandler } from '@application/commands/confirm-booking.handler';

import { LifecycleController } from '@interface/http/lifecycle.controller';
import { RescheduleHandler } from '@application/commands/reschedule.handler';
import { WaitlistHandler } from '@application/commands/waitlist.handler';
import { WaitlistController } from '@interface/http/waitlist.controller';
import { LifecycleHandler } from '@application/commands/lifecycle.handler';

@Module({
  controllers: [
    WaitlistController,
    AvailabilityController,
    HealthController,
    HoldsController,
    BookingsController,
    LifecycleController,
  ],
  providers: [
    WaitlistHandler,
    RescheduleHandler,
    ConfirmBookingHandler,
    GetAvailabilityHandler,
    GetCatalogueHandler,
    LifecycleHandler,
    PlaceHoldHandler,
    { provide: BOOKING_CONTEXT, useClass: DbBookingContext },
  ],
})
export class AvailabilityModule {}
