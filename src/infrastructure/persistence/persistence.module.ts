import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
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
    PrismaService,
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
  ],
  exports: [
    PrismaService,
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
  ],
})
export class PersistenceModule {}
