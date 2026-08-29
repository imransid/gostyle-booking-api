import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability.module';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';

import { APP_GUARD } from '@nestjs/core';
import { BookingAuthGuard } from './auth/booking-auth.guard';
import { TenantMiddleware } from './infrastructure/tenancy/tenant.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PersistenceModule,
    AuthModule,
    AvailabilityModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: BookingAuthGuard }],
})
export class AppModule implements NestModule {
  /**
   * Every route, including the public ones. A walk-in joined without a token
   * still belongs to a tenant, and the webhook that pays for it carries the
   * same header.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
