import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability.module';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PersistenceModule,
    AuthModule,
    AvailabilityModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
