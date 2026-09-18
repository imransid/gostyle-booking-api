import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { BookingReadHandler } from '@application/queries/read-models.handler';
import { BranchId } from './branch.decorator';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
import { LIST_FILTERS } from '@application/contract/screen-view';
import { BOOKING_HORIZON_DAYS } from '@domain/booking/recurrence';
import {
  BookingEventListDto,
  BookingListDto,
  CalendarDayDto,
  SearchResultsDto,
  SeriesBoardDto,
  SummaryDto,
  WaitlistBoardDto,
  WorklistDto,
} from './read-model.dto';

/**
 * The read side of the seven booking screens.
 *
 * REGISTERED BEFORE BookingsController, and that is load-bearing rather than
 * tidy: BookingsController carries `@Get(':id')`, which swallows every
 * literal at that depth. `/v1/bookings/summary` reaching the detail handler
 * with id = "summary" is a quiet failure — a plausible 404 from the wrong
 * place — so route-order.spec.ts asserts the order rather than trusting it.
 *
 * @DeskOnly on all of it. Every route here reads ACROSS customers: the day
 * grid, the worklist, the cancellation feed and the command palette are the
 * salon's view of its own diary, and a customer token reaching any of them
 * would be reading other people's appointments.
 */
@ApiTags('read-models')
@Controller('bookings')
@DeskOnly()
export class ReadModelsController {
  constructor(private readonly reads: BookingReadHandler) {}

  @Get('summary')
  @ApiOperation({
    summary: 'The overview KPI strip and its trend',
    description:
      'Deltas are SERVER-RENDERED display strings, already compared against ' +
      'the prior window of the same length. The client must not compute one: ' +
      'a count moves by a percentage, a rate by points and an average by an ' +
      'absolute amount, and getting that wrong flips a sign on a dashboard.',
  })
  @ApiQuery({ name: 'range', required: false, example: 7 })
  @ApiOkResponse({
    type: SummaryDto,
    description: 'KPIs and the trend series.',
  })
  summary(
    @BranchId() branchId: string,
    @Query('range') range?: string,
  ): Promise<unknown> {
    return this.reads.summary(branchId, readRange(range));
  }

  @Get('worklist')
  @ApiOperation({
    summary: 'Everything that needs a human, with the screen that fixes it',
    description:
      'One row per real problem. A tile is ABSENT when its count is zero ' +
      'rather than present and empty, so the strip is never a row of noughts.',
  })
  @ApiOkResponse({ type: WorklistDto })
  worklist(@BranchId() branchId: string): Promise<unknown> {
    return this.reads.worklist(branchId);
  }

  @Get('calendar/day')
  @ApiOperation({
    summary: 'The day grid, its columns and its KPIs',
    description:
      'Utilisation is measured against SELLABLE minutes — the published ' +
      'shift, less approved time off — never against trading hours. A ' +
      'stylist rostered 10:00-14:00 and fully booked reads 100%, not 33%.',
  })
  @ApiQuery({ name: 'date', example: '2026-07-13' })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiOkResponse({ type: CalendarDayDto })
  day(
    @BranchId() branchId: string,
    @Query('date') date: string,
    @Query('staffId') staffId?: string,
    @Query('status') status?: string,
  ): Promise<unknown> {
    return this.reads.day(branchId, date, { staffId, status });
  }

  @Get('calendar/week')
  @ApiOperation({ summary: 'Seven day summaries from a start date' })
  @ApiQuery({ name: 'from', example: '2026-07-13' })
  week(
    @BranchId() branchId: string,
    @Query('from') from: string,
  ): Promise<unknown> {
    return this.reads.week(branchId, from);
  }

  @Get('calendar/month')
  @ApiOperation({
    summary: 'One cell per day, and whether it is bookable',
    description:
      '`withinHorizon` is false past the lead limit. Those cells are real ' +
      'days that cannot be sold yet, which is different from a closed day.',
  })
  @ApiQuery({ name: 'month', example: '2026-07' })
  month(
    @BranchId() branchId: string,
    @Query('month') month: string,
  ): Promise<unknown> {
    return this.reads.month(branchId, month, BOOKING_HORIZON_DAYS);
  }

  @Get('search')
  @ApiOperation({
    summary: 'The command palette',
    description:
      'Ranked in the domain, not in SQL: "exact code matches first" is a ' +
      'rule, and a rule written twice is a rule that drifts. A purely ' +
      'numeric query shorter than three characters matches nothing.',
  })
  @ApiQuery({ name: 'q' })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiOkResponse({ type: SearchResultsDto })
  search(
    @BranchId() branchId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.reads.search(branchId, q ?? '', clamp(limit, 10, 1, 50));
  }

  @Get('events')
  @ApiOperation({
    summary: 'Cancellations and no-shows',
    description:
      'Read out of the status history rather than a second event table: ' +
      'every lifecycle write already appends the actor and the reason, and a ' +
      'parallel log is a copy that can disagree with it.',
  })
  @ApiQuery({ name: 'range', required: false, example: 30 })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: ['ALL', 'NO_SHOW', 'CANCELLED'],
  })
  @ApiOkResponse({ type: BookingEventListDto })
  events(
    @BranchId() branchId: string,
    @Query('range') range?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.reads.events({
      branchId,
      range: readRange(range, 30),
      kind,
      page: clamp(page, 1, 1, 10_000),
      pageSize: clamp(pageSize, 25, 1, 100),
    });
  }

  @Get('events/:id')
  @ApiOperation({
    summary: 'One event, with the worked policy maths',
    description:
      'The figures the policy actually used, so the desk can answer a ' +
      'dispute without anyone re-deriving them by hand.',
  })
  event(@Param('id', ResourceIdPipe) id: string): Promise<unknown> {
    return this.reads.event(id);
  }

  @Get('waitlist')
  @ApiOperation({
    summary: 'The waitlist board',
    description:
      '`waiting` arrives in the SERVER\u2019s rank order and the client renders ' +
      'the position from it. Ranking is join order today; the tier weighting ' +
      'in the front-end contract is an open decision, recorded in ' +
      'domain/booking/waitlist.ts, not an omission.',
  })
  @ApiOkResponse({ type: WaitlistBoardDto })
  waitlist(@BranchId() branchId: string): Promise<unknown> {
    return this.reads.waitlist(branchId);
  }

  @Get('series')
  @ApiOperation({
    summary: 'The recurring screen',
    description:
      'Health is DERIVED from the occurrences that exist, never stored: a ' +
      'stored flag and the occurrences are two facts that can disagree, and ' +
      'the stored one is always the wrong one.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ALL', 'ACTIVE', 'PAUSED', 'ENDED', 'COMPLETED', 'AT_RISK'],
  })
  @ApiOkResponse({ type: SeriesBoardDto })
  series(
    @BranchId() branchId: string,
    @Query('status') status?: string,
  ): Promise<unknown> {
    return this.reads.series(branchId, status);
  }

  @Get()
  @ApiOperation({
    summary: 'The upcoming list, and every other filtered read',
    description:
      'Sorted by start, ascending. `counts` are computed against the ' +
      'UNFILTERED set, because a chip showing the size of what you are ' +
      'already looking at would read the same number every time.',
  })
  @ApiQuery({ name: 'filter', required: false, enum: LIST_FILTERS })
  @ApiQuery({ name: 'from', required: false, example: '2026-07-13' })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiOkResponse({ type: BookingListDto })
  list(
    @BranchId() branchId: string,
    @Query('filter') filter?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('staffId') staffId?: string,
    @Query('customerId') customerId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.reads.list({
      branchId,
      filter,
      from,
      to,
      staffId,
      customerId,
      page: clamp(page, 1, 1, 10_000),
      pageSize: clamp(pageSize, 25, 1, 100),
    });
  }
}

/** 7, 30 or 90. Anything else is the default rather than a 400. */
function readRange(raw: string | undefined, fallback = 7): number {
  const n = Number(raw);
  return n === 7 || n === 30 || n === 90 ? n : fallback;
}

function clamp(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
