import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OutboxRelay } from '../messaging/outbox-relay.service';
import { ReminderRepository } from './reminder.repository';
import { RescheduleRepository } from './reschedule.repository';
import { WaitlistRepository } from './waitlist.repository';
import { WaitlistListener } from '../messaging/waitlist-listener';
import { GroupStatusListener } from '../messaging/group-status-listener';
import { WaitlistSweeper } from '../scheduling/waitlist-sweeper.service';
import { NoShowSweeper } from '../scheduling/no-show-sweeper.service';
import { PaymentLinkSweeper } from '../scheduling/payment-link-sweeper.service';
import { PAYMENT_GATEWAY } from '@application/ports/payment-gateway.port';
import { SimulatedGateway } from '../payments/simulated-gateway';
import { PaymentWebhookRepository } from './payment-webhook.repository';
import { GroupHoldRepository } from './group-hold.repository';
import { GroupConfirmRepository } from './group-confirm.repository';
import { ReminderScheduler } from '../scheduling/reminder-scheduler.service';
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
import { SeriesRepository } from './series.repository';
import { RosterChangeRepository } from './roster-change.repository';
import { CompactionRepository } from './compaction.repository';

/**
 * Global on purpose. One connection pool per process, shared by every module
 * that needs it. Importing PersistenceModule in five places would still give
 * one instance, but marking it global says so out loud.
 */
@Global()
@Module({
  providers: [
    CompactionRepository,
    RosterChangeRepository,
    SeriesRepository,
    GroupConfirmRepository,
    GroupHoldRepository,
    PaymentWebhookRepository,
    SimulatedGateway,
    // One line changes when a real provider is chosen.
    { provide: PAYMENT_GATEWAY, useExisting: SimulatedGateway },
    PaymentLinkSweeper,
    NoShowSweeper,
    WaitlistRepository,
    WaitlistSweeper,
    RescheduleRepository,
    ReminderRepository,
    ReminderScheduler,
    // Swapping this for the real customer service changes ONE line.
    { provide: CUSTOMER_CONTEXT, useClass: FixtureCustomerContext },
    PrismaService,
    OutboxRelay,
    // The publisher is a CHAIN, not a single thing.
    //
    // WaitlistListener answers to EVENT_PUBLISHER and forwards to the real
    // one, so every path that frees a slot triggers an offer without any of
    // them knowing the waitlist exists.
    //
    // The inner publisher gets its own token. Without it, the listener would
    // inject the token it also provides, and Nest would fail at boot with a
    // circular dependency rather than at compile time.
    LoggingEventPublisher,
    {
      provide: EVENT_PUBLISHER,
      // The chain, innermost last: an event passes the group listener, then
      // the waitlist listener, then reaches the real publisher. Each link
      // does its own job and forwards, so adding a third changes one line.
      useFactory: (
        next: LoggingEventPublisher,
        waitlist: WaitlistRepository,
        prisma: PrismaService,
      ) =>
        new GroupStatusListener(new WaitlistListener(next, waitlist), prisma),
      inject: [LoggingEventPublisher, WaitlistRepository, PrismaService],
    },
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
  ],
  exports: [
    CompactionRepository,
    RosterChangeRepository,
    SeriesRepository,
    GroupConfirmRepository,
    GroupHoldRepository,
    PaymentWebhookRepository,
    PAYMENT_GATEWAY,
    SimulatedGateway,
    PaymentLinkSweeper,
    NoShowSweeper,
    WaitlistRepository,
    WaitlistSweeper,
    RescheduleRepository,
    ReminderRepository,
    ReminderScheduler,
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
