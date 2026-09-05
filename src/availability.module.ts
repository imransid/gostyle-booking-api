import { Module } from '@nestjs/common';
import { AvailabilityController } from '@interface/http/availability.controller';
import {
  GetAvailabilityHandler,
  GetCatalogueHandler,
} from '@application/queries/get-availability.handler';
import { BOOKING_CONTEXT } from '@application/ports/booking-context.port';
import { HealthController } from '@interface/http/health.controller';
import { SettingsController } from '@interface/http/settings.controller';
import { QuoteController } from '@interface/http/quote.controller';
import { GetQuoteHandler } from '@application/queries/get-quote.handler';
import { GroupAvailabilityController } from '@interface/http/group-availability.controller';
import { GroupAvailabilityHandler } from '@application/queries/group-availability.handler';
import { BookingSeriesController } from '@interface/http/booking-series.controller';
import { SeriesPreviewHandler } from '@application/queries/series-preview.handler';
import { GetSettingsHandler } from '@application/queries/get-settings.handler';
import { EligibleStaffController } from '@interface/http/eligible-staff.controller';
import { GetEligibleStaffHandler } from '@application/queries/get-eligible-staff.handler';
import { GetBookingHandler } from '@application/queries/get-booking.handler';
import { PaymentLinkHandler } from '@application/commands/payment-link.handler';

import { HoldsController } from '@interface/http/holds.controller';
import { PlaceHoldHandler } from '@application/commands/place-hold.handler';
import { DbBookingContext } from '@infrastructure/persistence/db-booking-context';

import { BookingsController } from '@interface/http/bookings.controller';
import { ConfirmBookingHandler } from '@application/commands/confirm-booking.handler';

import { LifecycleController } from '@interface/http/lifecycle.controller';
import { RescheduleHandler } from '@application/commands/reschedule.handler';
import { WaitlistHandler } from '@application/commands/waitlist.handler';
import { WaitlistController } from '@interface/http/waitlist.controller';
import { WebhooksController } from '@interface/http/webhooks.controller';
import { GroupsController } from '@interface/http/groups.controller';
import { GroupHoldHandler } from '@application/commands/group-hold.handler';
import { GroupConfirmHandler } from '@application/commands/group-confirm.handler';
import { PaymentWebhookHandler } from '@application/commands/payment-webhook.handler';
import { LifecycleHandler } from '@application/commands/lifecycle.handler';
import { SeriesController } from '@interface/http/series.controller';
import {
  CreateSeriesHandler,
  SeriesLifecycleHandler,
  SeriesPanelHandler,
} from '@application/commands/series.handler';
import { MaterialiseSeriesHandler } from '@application/commands/materialise-series.handler';
import { SeriesMaterialiser } from '@infrastructure/scheduling/series-materialiser.service';
import { RosterChangesController } from '@interface/http/roster-changes.controller';
import { RosterChangeHandler } from '@application/commands/roster-change.handler';
import { CompactionController } from '@interface/http/compaction.controller';
import { CompactionHandler } from '@application/commands/compaction.handler';
import { WalkInsController } from '@interface/http/walk-ins.controller';
import { WalkInHandler } from '@application/commands/walk-in.handler';
import { AuthModule } from './auth/auth.module';

@Module({
  // For the health endpoint's customer auth rail. AuthModule exports the
  // service; nothing here verifies a token -- the guard is global.
  imports: [AuthModule],
  controllers: [
    // The /v1/bookings literals come first: BookingsController carries
    // @Get(':id'), which swallows every literal at that depth. Asserted by
    // route-order.spec.ts, not left to memory.
    SettingsController,
    EligibleStaffController,
    QuoteController,
    GroupAvailabilityController,
    BookingSeriesController,
    WalkInsController,
    CompactionController,
    RosterChangesController,
    SeriesController,
    GroupsController,
    WebhooksController,
    WaitlistController,
    AvailabilityController,
    HealthController,
    HoldsController,
    BookingsController,
    LifecycleController,
  ],
  providers: [
    GetSettingsHandler,
    GetQuoteHandler,
    GroupAvailabilityHandler,
    SeriesPreviewHandler,
    GetEligibleStaffHandler,
    GetBookingHandler,
    PaymentLinkHandler,
    WalkInHandler,
    CompactionHandler,
    RosterChangeHandler,
    CreateSeriesHandler,
    SeriesPanelHandler,
    SeriesLifecycleHandler,
    MaterialiseSeriesHandler,
    SeriesMaterialiser,
    GroupConfirmHandler,
    GroupHoldHandler,
    PaymentWebhookHandler,
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
