import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import { BranchContext } from '../tenancy/branch-context';
import { IdempotencyRepository } from './idempotency.repository';
import { DeskExtrasRepository } from './desk-extras.repository';
import { MobilePaymentRepository } from './mobile-payment.repository';
import { MobileGroupConfirmRepository } from './mobile-group-confirm.repository';
import { MobileSeriesRepository } from './mobile-series.repository';
import { PlatformServiceCatalogue } from './platform-service-catalogue';
import { PlatformStaffRoster } from './platform-staff-roster';
import { ServicesGrpcModule } from '../grpc/services-grpc.module';
import { StaffGrpcModule } from '../grpc/staff-grpc.module';
import { ConfirmAskSweeper } from '../scheduling/confirm-ask-sweeper.service';
import { RiskFlagSweeper } from '../scheduling/risk-flag-sweeper.service';
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
import { WalkInRepository } from './walk-in.repository';
import { WalkInGapListener } from '../messaging/walk-in-gap-listener';
import { WalkInSeatedListener } from '../messaging/walk-in-seated-listener';
import { StylistRepository } from './stylist.repository';
import { PlatformProductCatalogue } from './platform-product-catalogue';
import { ProductsGrpcModule } from '../grpc/products-grpc.module';

import { PushListener } from '../messaging/push-listener';
import { PushNotificationClient } from '../messaging/push-notification.client';
import { ReminderDeliveryListener } from '../messaging/reminder-delivery-listener';
import { SmtpEmailClient } from '../messaging/smtp-email.client';
import { NotificationDeliveryRepository } from './notification-delivery.repository';
import { ConsumerDirectoryGrpcModule } from '../grpc/consumer-directory-grpc.module';
import { BranchClockCheck } from '../tenancy/branch-clock.check';
import { PUSH_SENDER } from '@application/ports/push-sender.port';
import { EMAIL_SENDER } from '@application/ports/email-sender.port';

/**
 * Global on purpose. One connection pool per process, shared by every module
 * that needs it. Importing PersistenceModule in five places would still give
 * one instance, but marking it global says so out loud.
 */
@Global()
@Module({
  /**
   * PlatformServiceCatalogue injects SERVICES_DIRECTORY, which is provided
   * and exported by ServicesGrpcModule. Without this import Nest cannot
   * resolve it and the whole app fails at boot -- which tsc does not catch,
   * because a Nest token is not a type.
   *
   * PlatformStaffRoster and StaffGrpcModule are the same pair for the roster.
   *
   * ConsumerDirectoryGrpcModule provides CUSTOMER_CONTACT, the reminder
   * dispatcher's way to an email address; it is re-exported below so the
   * handler can inject it from anywhere this global module reaches.
   */
  imports: [
    ServicesGrpcModule,
    StaffGrpcModule,
    ProductsGrpcModule,
    ConsumerDirectoryGrpcModule,
  ],
  providers: [
    TenantContext,
    BranchContext,
    IdempotencyRepository,
    DeskExtrasRepository,
    MobilePaymentRepository,
    MobileGroupConfirmRepository,
    MobileSeriesRepository,
    PlatformServiceCatalogue,
    PlatformStaffRoster,
    ConfirmAskSweeper,
    RiskFlagSweeper,
    WalkInRepository,
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
    PushNotificationClient,
    SmtpEmailClient,
    NotificationDeliveryRepository,
    BranchClockCheck,
    // The reminder dispatcher's ports. Push makes ONE attempt per claim: the
    // dispatcher retries with backoff, and three in-line tries per row would
    // hold a whole batch behind a push-app outage. PushListener keeps the
    // client's own three quick tries, because nothing retries for it.
    {
      provide: PUSH_SENDER,
      useFactory: (push: PushNotificationClient) => ({
        configured: () => push.configured(),
        send: (request: Parameters<PushNotificationClient['send']>[0]) =>
          push.send(request, 1),
      }),
      inject: [PushNotificationClient],
    },
    { provide: EMAIL_SENDER, useExisting: SmtpEmailClient },
    {
      provide: EVENT_PUBLISHER,
      // The chain, innermost last: group, walk-in seated, walk-in gap,
      // waitlist, push, reminder delivery, then the real publisher.
      //
      // Reminder delivery is innermost because it is the one link that
      // throws (a lost reminder is worse than a re-delivered event); every
      // link outside it has already done its idempotent work by then.
      useFactory: (
        next: LoggingEventPublisher,
        waitlist: WaitlistRepository,
        prisma: PrismaService,
        walkIns: WalkInRepository,
        push: PushNotificationClient,
        deliveries: NotificationDeliveryRepository,
      ) =>
        new GroupStatusListener(
          new WalkInSeatedListener(
            new WalkInGapListener(
              new WaitlistListener(
                new PushListener(
                  new ReminderDeliveryListener(next, deliveries),
                  prisma,
                  push,
                ),
                waitlist,
              ),
              prisma,
            ),
            walkIns,
          ),
          prisma,
        ),
      inject: [
        LoggingEventPublisher,
        WaitlistRepository,
        PrismaService,
        WalkInRepository,
        PushNotificationClient,
        NotificationDeliveryRepository,
      ],
    },
    LifecycleRepository,
    BookingRepository,
    HoldRepository,
    HoldSweeper,
    DbBookingContext,
    FixtureBookingContext,
    StylistRepository,
    PlatformProductCatalogue,
  ],
  exports: [
    TenantContext,
    BranchContext,
    IdempotencyRepository,
    DeskExtrasRepository,
    MobilePaymentRepository,
    MobileGroupConfirmRepository,
    MobileSeriesRepository,
    PlatformServiceCatalogue,
    PlatformStaffRoster,
    ConfirmAskSweeper,
    RiskFlagSweeper,
    WalkInRepository,
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
    StylistRepository,
    PlatformProductCatalogue,
    NotificationDeliveryRepository,
    PUSH_SENDER,
    EMAIL_SENDER,
    ConsumerDirectoryGrpcModule,
  ],
})
export class PersistenceModule {}
