import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BookingReadHandler } from '@application/queries/read-models.handler';
import { BranchId } from './branch.decorator';
import { DeskOnly } from '../../auth/desk-only.decorator';
import { ResourceIdPipe } from './resource-id.pipe';
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
import {
  BookingListQuery,
  CalendarDayQuery,
  CalendarMonthQuery,
  CalendarWeekQuery,
  EventsQuery,
  SearchQuery,
  SeriesBoardQuery,
  SummaryQuery,
  WaitlistBoardQuery,
  WorklistQuery,
} from './read-models.query';

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
  @ApiOkResponse({
    type: SummaryDto,
    description: 'KPIs and the trend series.',
  })
  summary(
    @BranchId() branchId: string,
    @Query() q: SummaryQuery,
  ): Promise<unknown> {
    return this.reads.summary(branchId, q.range ?? 7);
  }

  @Get('worklist')
  @ApiOperation({
    summary: 'Everything that needs a human, with the screen that fixes it',
    description:
      'One row per real problem. A tile is ABSENT when its count is zero ' +
      'rather than present and empty, so the strip is never a row of noughts.',
  })
  @ApiOkResponse({ type: WorklistDto })
  worklist(
    @BranchId() branchId: string,
    @Query() _q: WorklistQuery,
  ): Promise<unknown> {
    return this.reads.worklist(branchId);
  }

  @Get('calendar/day')
  @ApiOperation({
    summary: 'The day grid, its columns and its KPIs',
    description:
      'Utilisation is measured against SELLABLE minutes — the published ' +
      'shift, less approved time off — never against trading hours. A ' +
      'stylist rostered 10:00-14:00 and fully booked reads 100%, not 33%. ' +
      'With `staffId` the whole strip narrows to those professionals, ' +
      'denominator included.',
  })
  @ApiOkResponse({ type: CalendarDayDto })
  day(
    @BranchId() branchId: string,
    @Query() q: CalendarDayQuery,
  ): Promise<unknown> {
    return this.reads.day(branchId, q.date, {
      staffId: q.staffId,
      serviceId: q.serviceId,
      status: q.status,
      payment: q.payment,
    });
  }

  @Get('calendar/week')
  @ApiOperation({ summary: 'Seven day summaries from a start date' })
  week(
    @BranchId() branchId: string,
    @Query() q: CalendarWeekQuery,
  ): Promise<unknown> {
    return this.reads.week(branchId, q.from, {
      staffId: q.staffId,
      serviceId: q.serviceId,
      status: q.status,
      payment: q.payment,
    });
  }

  @Get('calendar/month')
  @ApiOperation({
    summary: 'One cell per day, and whether it is bookable',
    description:
      '`withinHorizon` is false past the lead limit. Those cells are real ' +
      'days that cannot be sold yet, which is different from a closed day.',
  })
  @ApiOkResponse({ type: CalendarDayDto })
  month(
    @BranchId() branchId: string,
    @Query() q: CalendarMonthQuery,
  ): Promise<unknown> {
    return this.reads.month(branchId, q.month, BOOKING_HORIZON_DAYS);
  }

  @Get('search')
  @ApiOperation({
    summary: 'The command palette',
    description:
      'Ranked in the domain, not in SQL: "exact code matches first" is a ' +
      'rule, and a rule written twice is a rule that drifts. A purely ' +
      'numeric query shorter than three characters matches nothing. A ' +
      'SERVICE hit carries the id the availability engine answers to, not ' +
      'the stored one.',
  })
  @ApiOkResponse({ type: SearchResultsDto })
  search(
    @BranchId() branchId: string,
    @Query() q: SearchQuery,
  ): Promise<unknown> {
    return this.reads.search(branchId, q.q, q.limit ?? 10);
  }

  @Get('events')
  @ApiOperation({
    summary: 'Cancellations and no-shows',
    description:
      'Read out of the status history rather than a second event table: ' +
      'every lifecycle write already appends the actor and the reason, and a ' +
      'parallel log is a copy that can disagree with it. `summary` and ' +
      '`reasons` are computed over the WHOLE range and the active kind, not ' +
      'over the page. LATE_CANCEL is a real filter, not an alias of ' +
      'CANCELLED, and an unknown kind is a 400 rather than a coercion.',
  })
  @ApiOkResponse({ type: BookingEventListDto })
  events(
    @BranchId() branchId: string,
    @Query() q: EventsQuery,
  ): Promise<unknown> {
    return this.reads.events({
      branchId,
      range: q.range ?? 30,
      kind: q.kind ?? 'ALL',
      page: q.page ?? 1,
      pageSize: Math.min(100, q.pageSize ?? 25),
    });
  }

  @Get('events/:id')
  @ApiOperation({
    summary: 'One event, with the worked policy maths',
    description:
      'Carries every field the list row carries, plus the maths — a deep ' +
      'link has no row to merge with. The figures are the ones the policy ' +
      'actually used, so the desk can answer a dispute without re-deriving ' +
      'them by hand.',
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
  waitlist(
    @BranchId() branchId: string,
    @Query() _q: WaitlistBoardQuery,
  ): Promise<unknown> {
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
  @ApiOkResponse({ type: SeriesBoardDto })
  series(
    @BranchId() branchId: string,
    @Query() q: SeriesBoardQuery,
  ): Promise<unknown> {
    return this.reads.series(branchId, q.status);
  }

  @Get()
  @ApiOperation({
    summary: 'The upcoming list, and every other filtered read',
    description:
      'Sorted by start, ascending. `counts` are computed against the ' +
      'UNFILTERED set, because a chip showing the size of what you are ' +
      'already looking at would read the same number every time. `kpis` are ' +
      'the opposite: the month’s four tiles over this list’s own window and ' +
      'filters. `from` and `to` are both INCLUSIVE trading days. `pageSize` ' +
      'is capped at 100 and the response echoes the value actually used.',
  })
  @ApiOkResponse({ type: BookingListDto })
  list(
    @BranchId() branchId: string,
    @Query() q: BookingListQuery,
  ): Promise<unknown> {
    return this.reads.list({
      branchId,
      filter: q.filter,
      from: q.from,
      to: q.to,
      staffId: q.staffId,
      customerId: q.customerId,
      page: q.page ?? 1,
      pageSize: Math.min(100, q.pageSize ?? 25),
    });
  }
}
