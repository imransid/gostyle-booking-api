import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { MobileSeriesEnabledGuard } from './mobile-series.flag';
import {
  MobileSeriesJobHandler,
  type MobileSeriesJobReport,
} from '@application/commands/mobile-series-job.handler';

/**
 * POST /v1/mobile-booking/series-job/run (step 8): the hourly app routine
 * job, now.
 *
 * Desk only (a customer token is refused), and behind MOBILE_SERIES_BOOKING
 * like every routine route. For the desk, and for proving the job live
 * without waiting an hour. Running it again is harmless: every write it
 * makes is claimed, so a second run only finds the work done.
 */
@DeskOnly()
@UseGuards(MobileSeriesEnabledGuard)
@Controller('mobile-booking/series-job')
export class MobileSeriesJobController {
  constructor(private readonly job: MobileSeriesJobHandler) {}

  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the app routine job now',
    description:
      'The hourly job, at once: ends the pauses whose date has come, ' +
      'completes the routines whose visits are all closed, writes the 48 ' +
      'hour reminders, pauses a routine after 2 missed visits, and keeps ' +
      'the desk job away from app routines. Desk ' +
      'only. Safe to run again.',
  })
  @ApiOkResponse({ description: 'What the run did, counted.' })
  run(): Promise<MobileSeriesJobReport> {
    return this.job.run();
  }
}
