import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes, declared so `/docs-json` carries them.
 *
 * WHY THESE EXIST. Every request DTO in this service is exact in the OpenAPI
 * document, and every RESPONSE was `{"200": {"description": ""}}`. The front
 * end therefore built each read model from the examples in a hand-written
 * guide -- so a field the guide happened not to show was a field nobody
 * rendered, and nothing would have caught that but a user noticing a blank.
 *
 * These classes are documentation, not validation: Nest returns plain
 * objects from the handlers and never instantiates them. They exist to be
 * read by a client generator. That means they CAN drift from the handler,
 * which is the honest cost of declaring them separately -- so they are kept
 * deliberately small and describe only what the screens read.
 */

export class MoneyPairDto {
  @ApiProperty({ example: 160, description: 'Whole AED.' })
  value!: number;

  @ApiProperty({
    example: '+18%',
    description: 'Server-rendered. Do not compute one.',
  })
  delta!: string;
}

export class StaffRefDto {
  @ApiProperty({ example: 'reem', nullable: true })
  id!: string | null;

  @ApiProperty({ example: 'Reem S.', nullable: true })
  name!: string | null;
}

export class BookingCustomerDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'GOLD', nullable: true }) tier!: string | null;
  @ApiProperty() isNew!: boolean;
  @ApiProperty() requiresDeposit!: boolean;
  @ApiProperty({ enum: ['LOW', 'WATCH', 'HIGH'] }) riskBand!: string;
  @ApiProperty({ example: 92 }) riskScore!: number;
}

export class BookingPaymentDto {
  @ApiProperty({ enum: ['NONE', 'PENDING', 'PAID', 'FULL'] })
  state!: string;

  @ApiProperty({ example: 0 }) deposit!: number;
  @ApiProperty({ example: 0 }) depositMinor!: number;

  @ApiProperty({
    enum: ['KEPT', 'FORFEITED', 'REFUNDED', 'GOODWILL'],
    nullable: true,
  })
  depositOutcome!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { source: 'Service rule 50% (Full color and gloss)' },
  })
  requirement!: { source: string | null };

  @ApiProperty({ nullable: true }) linkExpiresAt!: string | null;
}

export class BookingConflictDto {
  @ApiProperty({
    enum: [
      'SHIFT_CHANGE',
      'STAFF_OFF',
      'RESOURCE_OOS',
      'BRANCH_CLOSURE',
      'SKILL_REVOKED',
    ],
  })
  kind!: string;

  @ApiProperty({ example: 'called in sick' }) cause!: string;
  @ApiProperty({ example: 'staff.shift_published' }) sourceEvent!: string;
  @ApiProperty() raisedAt!: string;
  @ApiProperty({ nullable: true }) staffId!: string | null;
  @ApiProperty({ nullable: true }) resourceClass!: string | null;

  @ApiProperty({ description: 'The worklist this is resolved on.' })
  changeId!: string;

  @ApiProperty({
    description: 'POST …/conflicts/{changeId}/items/{itemId}/resolve',
  })
  itemId!: string;

  @ApiPropertyOptional({
    description:
      'Set once the ladder ran out of rungs and prepared a cancellation.',
  })
  proposed?: unknown;
}

export class BookingDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'GS-1041' }) code!: string;

  @ApiProperty({
    enum: [
      'PENDING_PAYMENT',
      'PENDING_CONFIRM',
      'CONFIRMED',
      'CHECKED_IN',
      'IN_SERVICE',
      'COMPLETED',
      'SETTLED',
      'NO_SHOW',
      'CANCELLED',
      'EXPIRED',
    ],
  })
  status!: string;

  @ApiProperty({
    example: 'RESCHEDULED',
    description:
      'Our own word, on every row. Three of the ten above are ambiguous: ' +
      'PENDING_CONFIRM takes draft/held/pending_confirmation, CANCELLED ' +
      'takes cancelled/rescheduled, EXPIRED takes expired/skipped.',
  })
  statusDetail!: string;

  @ApiProperty({ type: BookingCustomerDto }) customer!: BookingCustomerDto;
  @ApiProperty({ type: [String], example: ['Haircut and finish'] })
  services!: string[];

  @ApiProperty({
    enum: ['Hair', 'Nails', 'Skin', 'Brows', 'Other'],
    description:
      'The band the calendar colours by. Derived from resource classes.',
  })
  category!: string;

  @ApiProperty({ type: StaffRefDto }) staff!: StaffRefDto;
  @ApiProperty({ example: '2026-07-13' }) date!: string;
  @ApiProperty({ example: '12:45' }) startTime!: string;
  @ApiProperty({ example: '2026-07-13T08:45:00.000Z' }) startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty({ example: 120 }) durationMinutes!: number;
  @ApiProperty({ example: 700, description: 'Whole AED.' }) price!: number;
  @ApiProperty({ example: 70000, description: 'Fils. Prefer this one.' })
  priceMinor!: number;

  @ApiProperty({ type: BookingPaymentDto }) payment!: BookingPaymentDto;
  @ApiProperty({ example: 'DESK' }) channel!: string;
  @ApiProperty({ example: 0 }) moveCount!: number;
  @ApiProperty({ description: 'The 24-hour confirm-or-move message went out.' })
  reminded!: boolean;

  @ApiProperty({ type: 'object', additionalProperties: true })
  remindedAt!: Record<string, string | null>;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  overbook!: { reason: string | null } | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  group!: { id: string } | null;

  @ApiProperty({
    type: BookingConflictDto,
    nullable: true,
    description: 'Null on a healthy booking. Drives the CONFLICTS chip.',
  })
  conflict!: BookingConflictDto | null;

  @ApiProperty({ type: [String], example: ['styling'] })
  resourceTypes!: string[];
}

export class BookingListDto {
  @ApiProperty({ type: [BookingDto] }) data!: BookingDto[];
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 25 }) pageSize!: number;
  @ApiProperty({ example: 186 }) total!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'ALL, TODAY, TOMORROW, DEPOSIT_PENDING, CONFLICTS and NOT_REMINDED are ' +
      'always present. UNCONFIRMED is not currently counted.',
    example: {
      ALL: 42,
      TODAY: 6,
      TOMORROW: 4,
      DEPOSIT_PENDING: 2,
      CONFLICTS: 1,
      NOT_REMINDED: 9,
    },
  })
  counts!: Record<string, number>;
}

export class CalendarColumnDto {
  @ApiProperty({ example: 'reem' }) staffId!: string;
  @ApiProperty({ example: 'Reem S.' }) name!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { fromMinute: 600, toMinute: 1080 },
  })
  shift!: { fromMinute: number; toMinute: number };

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'ALWAYS EMPTY today. Time off is excluded from availability but reaches the engine as opaque calendar entries, so there is no labelled list to publish.',
  })
  timeOff!: { fromMinute: number; toMinute: number }[];

  @ApiProperty({ example: 5 }) load!: number;
}

export class CalendarDayDto {
  @ApiProperty({ example: '2026-07-13' }) date!: string;
  @ApiProperty({ example: 600 }) openMinute!: number;
  @ApiProperty({ example: 1320 }) closeMinute!: number;
  @ApiProperty({ example: 825, description: 'Branch-local, not server-local.' })
  nowMinute!: number;

  @ApiProperty({ nullable: true }) closureReason!: string | null;
  @ApiProperty({ type: [CalendarColumnDto] }) columns!: CalendarColumnDto[];
  @ApiProperty({ type: [BookingDto] }) bookings!: BookingDto[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'utilisation is measured against SELLABLE minutes, not trading hours.',
    example: {
      booked: 17,
      utilisation: 0.62,
      revenue: 5240,
      pendingDeposits: 1,
      conflicts: 1,
      walkInsWaiting: 3,
    },
  })
  kpis!: Record<string, number>;
}

export class SummaryDto {
  @ApiProperty({ example: 7 }) range!: number;
  @ApiProperty({ type: MoneyPairDto }) bookings!: MoneyPairDto;
  @ApiProperty({ type: MoneyPairDto }) revenue!: MoneyPairDto;

  @ApiProperty({
    type: MoneyPairDto,
    description: '`value` is a fraction; delta is in points.',
  })
  showUpRate!: MoneyPairDto;

  @ApiProperty({ type: MoneyPairDto }) averageTicket!: MoneyPairDto;
  @ApiProperty({ type: MoneyPairDto }) noShows!: MoneyPairDto;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  trend!: { date: string; label: string; bookings: number; revenue: number }[];

  @ApiProperty({ example: 21 }) bookingsToday!: number;
}

export class BookingEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ example: 'GS-1041' }) code!: string;
  @ApiProperty({ enum: ['NO_SHOW', 'CANCELLED'] }) kind!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'STAFF', 'MANAGER', 'AUTO'] }) by!: string;
  @ApiProperty() occurredAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  customer!: { id: string };

  @ApiProperty({ example: 'Hair color and style' }) service!: string;
  @ApiProperty({ nullable: true }) staffId!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  slot!: { startTime: string; durationMinutes: number };

  @ApiProperty({ nullable: true }) reason!: string | null;

  @ApiProperty({ example: 150, description: 'Whole AED.' })
  servicePrice!: number;

  @ApiProperty({ example: 40, description: 'Whole AED.' })
  depositAmount!: number;

  @ApiProperty({
    enum: [
      'LOST',
      'DEPOSIT_KEPT',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'NO_CHARGE',
    ],
    description:
      'PARTIALLY_REFUNDED is the fully-prepaid 2-24h split. It used to fall ' +
      'through to LOST, which was wrong on screen and wrong in a dispute.',
  })
  outcome!: string;
}

export class BookingEventListDto {
  @ApiProperty({ type: [BookingEventDto] }) data!: BookingEventDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  summary!: Record<string, number>;
}

export class WorklistDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'A tile with a count of zero is ABSENT, not present-and-empty. Kinds: ' +
      'DEPOSITS_PENDING, CONFLICTS, SERIES_AT_RISK, WALK_INS_WAITING.',
  })
  items!: Record<string, unknown>[];
}

export class SearchResultsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Exact booking-code matches rank first.',
  })
  results!: { kind: string; id: string; label: string; detail: string }[];
}

export class WaitlistBoardDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  offered!: Record<string, unknown>[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'In the SERVER’s rank order. Render `position`; do not compute it.',
  })
  waiting!: Record<string, unknown>[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  summary!: Record<string, number>;
}

export class SeriesBoardDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  data!: Record<string, unknown>[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  summary!: Record<string, number>;
}

export class CustomerRiskDto {
  @ApiProperty() customerId!: string;
  @ApiProperty({ example: 92 }) score!: number;
  @ApiProperty({ enum: ['LOW', 'WATCH', 'HIGH'] }) band!: string;
  @ApiProperty({ nullable: true }) tier!: string | null;
  @ApiProperty() requiresDeposit!: boolean;
  @ApiProperty() isNew!: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Null, always. The port answers a band and a score, not the counts ' +
      'behind them, and back-solving a plausible history for a risk screen ' +
      'is worse than an honest gap.',
  })
  noShows!: number | null;

  @ApiProperty({ nullable: true }) lateCancels!: number | null;
  @ApiProperty({ nullable: true }) visits!: number | null;
  @ApiProperty() explanation!: string;
}
