import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  CALENDAR_CHIPS,
  LIST_FILTERS,
  PAYMENT_CHIPS,
} from '@application/contract/screen-view';
import { EVENT_KINDS } from '@domain/booking/cancellation-feed';

/**
 * QUERY DTOs, so the ValidationPipe sees the query string too.
 *
 * WHAT THIS FIXES. Body validation on this service was already good -- POST
 * /holds with junk returns a 400 naming every field. Query routes had nothing
 * in front of them, and failed three different wrong ways:
 *
 *   GET /walk-ins           (no branchId)  -> 500 "Something went wrong."
 *   GET /calendar/day?date=banana          -> 500, same body
 *   GET /events?kind=BANANA                -> 200, silently read as CANCELLED
 *
 * The 500s were the single largest time sink in the front end's integration:
 * four screens looked broken and were only calling the route wrong, and the
 * response named no field. The 200 is worse in kind -- a typo'd filter
 * returning confident, wrong data.
 *
 * `forbidNonWhitelisted` is already on globally, so declaring a DTO also
 * means an unknown parameter is refused instead of ignored. Every DTO here
 * therefore declares `branchId` even though the branch now comes from the
 * token: the front end sends it, and silently 400-ing that would be a
 * different regression.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** One or more chip names, comma-separated, nothing else. */
const CHIP_LIST = new RegExp(
  `^(${CALENDAR_CHIPS.join('|')})(,(${CALENDAR_CHIPS.join('|')}))*$`,
);

/** `branchId` is accepted everywhere and authoritative nowhere. See §1. */
class BranchScoped {
  @ApiPropertyOptional({
    description:
      'OPTIONAL and checked, not obeyed. The branch comes from the token ' +
      'when the token names one; sending a different one is 403 ' +
      'BOOKING_BRANCH_MISMATCH. GET /v1/bookings/settings publishes the ' +
      'branch this caller actually resolves to.',
  })
  @IsOptional()
  @IsString()
  branchId?: string;
}

/**
 * Whole numbers arrive as strings on a query string.
 *
 * A value that is not a number is passed THROUGH rather than coerced, so
 * `@IsInt` refuses it and the caller is told which field was wrong. Turning
 * it into NaN here would hide the mistake one layer earlier.
 */
const toInt = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }): unknown => {
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  });

class Paged extends BranchScoped {
  @ApiPropertyOptional({ example: 1, description: '1-based.' })
  @IsOptional()
  @toInt()
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @ApiPropertyOptional({
    example: 25,
    description:
      'CAPPED AT 100. A larger value is clamped rather than refused, and the ' +
      'response echoes what was actually used.',
  })
  @IsOptional()
  @toInt()
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class SummaryQuery extends BranchScoped {
  @ApiPropertyOptional({ enum: [7, 30, 90], example: 7 })
  @IsOptional()
  @toInt()
  @IsIn([7, 30, 90], { message: 'range must be 7, 30 or 90' })
  range?: number;
}

export class WorklistQuery extends BranchScoped {}

export class WaitlistBoardQuery extends BranchScoped {}

/** One or more payment chip names, comma-separated, nothing else. */
const PAYMENT_LIST = new RegExp(
  `^(${PAYMENT_CHIPS.join('|')})(,(${PAYMENT_CHIPS.join('|')}))*$`,
);

export class CalendarDayQuery extends BranchScoped {
  @ApiProperty({ example: '2026-09-18' })
  @Matches(DAY, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({
    description:
      'Narrows the grid to one professional. `kpis.utilisation` is then ' +
      'measured against THEIR sellable minutes, not the branch’s.',
  })
  @IsOptional()
  @IsString()
  staffId?: string;

  /**
   * THE VISIT-STATUS CHIPS, comma-separated.
   *
   * Checked here, not in the handler: `status` used to pass @IsString and
   * then be ignored entirely, so a typo returned the WHOLE day and looked
   * like a filter that had worked. The caller is now told which word was
   * wrong.
   *
   * EMPTY IS ABSENT. The chip bar sends `status=` when nothing is picked,
   * and that means the diary, not a 400. @IsOptional only skips a missing
   * value, so the empty string is made missing first.
   */
  @ApiPropertyOptional({
    enum: CALENDAR_CHIPS,
    isArray: true,
    example: 'checked_in,in_service',
    description: 'Comma-separated. Omit, or send empty, for every live status.',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @Matches(CHIP_LIST, {
    message: `status must be a comma-separated list of: ${CALENDAR_CHIPS.join(', ')}`,
  })
  status?: string;

  /**
   * THE PAYMENT CHIPS, comma-separated. A SECOND ROW, not more of the first.
   *
   * "Finished and unpaid" is the question the desk asks most, and one row of
   * chips cannot ask it.
   */
  @ApiPropertyOptional({
    enum: PAYMENT_CHIPS,
    isArray: true,
    example: 'unpaid',
    description:
      'Comma-separated. Omit, or send empty, for every payment state.',
  })
  @Transform(({ value }: { value: unknown }): unknown =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @Matches(PAYMENT_LIST, {
    message: `payment must be a comma-separated list of: ${PAYMENT_CHIPS.join(', ')}`,
  })
  payment?: string;
}

export class CalendarWeekQuery extends BranchScoped {
  @ApiProperty({
    example: '2026-09-14',
    description: 'The first of seven days.',
  })
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from!: string;
}

export class CalendarMonthQuery extends BranchScoped {
  @ApiProperty({ example: '2026-09' })
  @Matches(MONTH, { message: 'month must be YYYY-MM' })
  month!: string;
}

export class SearchQuery extends BranchScoped {
  @ApiProperty({ example: 'GS-1233' })
  @IsString()
  q!: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @toInt()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class EventsQuery extends Paged {
  @ApiPropertyOptional({ enum: [7, 30, 90], example: 30 })
  @IsOptional()
  @toInt()
  @IsIn([7, 30, 90], { message: 'range must be 7, 30 or 90' })
  range?: number;

  @ApiPropertyOptional({ enum: EVENT_KINDS })
  @IsOptional()
  @IsIn([...EVENT_KINDS], {
    message: `kind must be one of: ${EVENT_KINDS.join(', ')}`,
  })
  kind?: string;
}

export class SeriesBoardQuery extends BranchScoped {
  @ApiPropertyOptional({
    enum: ['ALL', 'ACTIVE', 'PAUSED', 'ENDED', 'COMPLETED', 'AT_RISK'],
  })
  @IsOptional()
  @IsIn(['ALL', 'ACTIVE', 'PAUSED', 'ENDED', 'COMPLETED', 'AT_RISK'], {
    message:
      'status must be one of: ALL, ACTIVE, PAUSED, ENDED, COMPLETED, AT_RISK',
  })
  status?: string;
}

export class BookingListQuery extends Paged {
  @ApiPropertyOptional({ enum: LIST_FILTERS })
  @IsOptional()
  @IsIn([...LIST_FILTERS], {
    message: `filter must be one of: ${LIST_FILTERS.join(', ')}`,
  })
  filter?: string;

  @ApiPropertyOptional({
    example: '2026-09-18',
    description: 'Trading day, INCLUSIVE.',
  })
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description:
      'Trading day, INCLUSIVE — `from=X&to=X` returns that one day. It used ' +
      'to be exclusive, which is why adding `to` collapsed a 102-row result ' +
      'to nothing.',
  })
  @IsOptional()
  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  staffId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;
}
