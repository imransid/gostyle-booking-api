import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * These classes exist ONLY to describe the HTTP response to Swagger.
 *
 * The handler returns plain interfaces, which have no runtime identity, so
 * Swagger cannot see them. Declaring the shape here keeps the docs honest
 * without dragging decorators into the application layer.
 */

export class StaffRefDto {
  @ApiProperty({ example: 'maya' })
  id!: string;

  @ApiProperty({ example: 'Maya E.' })
  name!: string;
}

export class OfferDto {
  @ApiProperty({
    example: 1105,
    description: 'Minutes from midnight. 900 is 15:00.',
  })
  startMin!: number;

  @ApiProperty({
    example: '18:25',
    description: 'Branch local time, for display only.',
  })
  start!: string;

  @ApiProperty({ example: 1230 })
  endMin!: number;

  @ApiProperty({ example: '20:30' })
  end!: string;

  @ApiProperty({
    type: [StaffRefDto],
    description:
      'Everyone who could take this exact start. More than one means the ' +
      'concrete pick can be deferred to confirm time.',
  })
  staff!: StaffRefDto[];
}

export class RankedOfferDto extends OfferDto {
  @ApiProperty({
    type: StaffRefDto,
    description:
      'First-free, least-loaded. Ties break by id so the answer is stable.',
  })
  assignedTo!: StaffRefDto;

  @ApiProperty({
    isArray: true,
    enum: ['EARLIEST', 'SMART_PICK', 'OVERLAP', 'FLUSH'],
    example: ['SMART_PICK', 'FLUSH'],
  })
  badges!: string[];

  @ApiProperty({
    example: 5.8,
    description: 'fragmentation minus half the delta capacity.',
  })
  score!: number;

  @ApiProperty({
    example: 6,
    description: 'What this start does to the shape of the day.',
  })
  fragmentation!: number;

  @ApiProperty({
    example: 0.4,
    description: 'Sellable starts destroyed. Lower is better.',
  })
  deltaCapacity!: number;

  @ApiProperty({
    type: [String],
    example: ['starts the moment the previous visit releases the chair'],
    description: 'Why this offer scored as it did, in plain English.',
  })
  why!: string[];
}

export class RefusalDto {
  @ApiProperty({ example: 'reem' })
  id!: string;

  @ApiProperty({ example: 'Reem S.' })
  name!: string;

  @ApiProperty({
    example: 'does not hold the required skills: color',
    description: 'Why this professional was dropped from the pool.',
  })
  reason!: string;
}

export class AvailabilityResponseDto {
  @ApiProperty({ example: 'marina-walk' })
  branchId!: string;

  @ApiProperty({ example: '2026-08-24' })
  tradingDay!: string;

  @ApiProperty({
    example: false,
    description:
      'When true, the channel lead time is applied to the earliest offer.',
  })
  isToday!: boolean;

  @ApiProperty({ example: 'desk', enum: ['desk', 'online'] })
  channel!: string;

  @ApiProperty({ example: 5, description: '5 at the desk, 15 online.' })
  grainMin!: number;

  @ApiProperty({
    example: 125,
    description: 'Total staff-busy minutes for the chain.',
  })
  durationMin!: number;

  @ApiProperty({ example: 7, description: 'How many feasible starts exist.' })
  count!: number;

  @ApiProperty({
    type: [RankedOfferDto],
    description: 'The three the operator sees. Ranked, badged, and explained.',
  })
  topOffers!: RankedOfferDto[];

  @ApiProperty({
    type: [OfferDto],
    description: 'Every feasible start, for the reschedule chip grid.',
  })
  offers!: OfferDto[];

  @ApiProperty({ type: [StaffRefDto], description: 'Who may take this chain.' })
  eligible!: StaffRefDto[];

  @ApiProperty({
    type: [RefusalDto],
    description: 'An empty window with no explanation is a support ticket.',
  })
  refusals!: RefusalDto[];

  @ApiPropertyOptional({
    example: 'Branch closed on Sundays',
    description: 'Present only when the branch is shut. Offers will be empty.',
  })
  closureReason?: string;

  @ApiProperty({
    example: 0.139,
    description: 'Server-side compute time in milliseconds.',
  })
  computeMs!: number;
}

export class ServiceSummaryDto {
  @ApiProperty({ example: 'full-colour' })
  id!: string;

  @ApiProperty({ example: 'Full color and gloss' })
  name!: string;

  @ApiProperty({ example: 'color' })
  skill!: string;

  @ApiProperty({ example: 2 })
  requiredLevel!: number;

  @ApiProperty({ example: 125 })
  durationMin!: number;

  @ApiProperty({ example: 'color' })
  resourceType!: string;

  @ApiPropertyOptional({
    example: { fromMin: 45, toMin: 85 },
    description: 'Hands-free window, measured from the service start.',
  })
  processing?: { fromMin: number; toMin: number };
}
