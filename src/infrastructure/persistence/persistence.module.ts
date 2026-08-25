import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OutboxRelay } from '../messaging/outbox-relay.service';
import { CUSTOMER_CONTEXT } from '@application/ports/customer-context.port';
import { FixtureCustomerContext } from '../fixtures/fixture-customer-context';
import { LoggingEventPublisher } from '../messaging/logging-event-publisher';
import { EVENT_PUBLISHER } from '@application/ports/event-publisher.port';
import { HoldRepository } from './hold.repository';
import { BookingRepository } from './booking.repository';
import { LifecycleRepository } from './lifecycle.repository';
import { DbBookingContext } from './db-booking-context';
import { FixtureBookingContext } from '../fixtures/fixture-booking-context';
import { HoldSweeper } from '../scheduling/hold-sweeper.service';

/**
 * Global on purpose. One connection pool per process, shared by every module
 * that needs it. Importing PersistenceModule in five places would still give
 * one instance, but marking it global says so out loud.
 */
@Global()
@Module({
  providers: [
    // Swapping this for the real customer service changes ONE line.
    { provide: CUSTOMER_CONTEXT, useClass: FixtureCustomerContext },
    PrismaService,
    OutboxRelay,
    { provide: EVENT_PUBLISHER, useClass: LoggingEventPublisher },
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
  ],
  exports: [
    CUSTOMER_CONTEXT,
    PrismaService,
    OutboxRelay,
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
  ],
})
export class PersistenceModule {}
