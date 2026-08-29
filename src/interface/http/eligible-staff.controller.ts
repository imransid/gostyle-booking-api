import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  GetEligibleStaffHandler,
  type EligibleStaffView,
} from '@application/queries/get-eligible-staff.handler';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class EligibleStaffQueryDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branch: string = 'marina-walk';

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DAY, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: 'full-colour',
    description: 'Comma-separated, in chain order.',
  })
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  )
  @IsArray()
  @ArrayNotEmpty({ message: 'pick at least one service' })
  @IsString({ each: true })
  services!: string[];

  @ApiPropertyOptional({
    example: 'maya',
    description: 'Ask about one person. Omit for the whole roster.',
  })
  @IsOptional()
  @IsString()
  staffId?: string;
}

/**
 * Who may take this chain, before a time exists.
 *
 * Stage 2 of the wizard needs this: the services are chosen, no slot has been
 * picked, and the operator has to be told who can do the work and why the
 * person they asked for cannot.
 *
 * Under /v1/bookings, in its own controller, registered before
 * BookingsController -- see the note on SettingsController for why that
 * ordering is load-bearing.
 */
@ApiTags('availability')
@Controller('bookings')
export class EligibleStaffController {
  constructor(private readonly handler: GetEligibleStaffHandler) {}

  @Get('eligible-staff')
  @ApiOperation({
    summary: 'Which professionals can take this chain',
    description:
      'Runs the SAME eligibility the availability engine runs, so the two ' +
      'can never disagree about who is certified. Refusals are named with ' +
      'their reason.',
  })
  @ApiOkResponse({ description: 'The eligible pool and the refusals.' })
  @ApiNotFoundResponse({
    description: 'One of the service ids does not exist.',
  })
  get(@Query() q: EligibleStaffQueryDto): Promise<EligibleStaffView> {
    return this.handler.execute({
      branchId: q.branch,
      tradingDay: q.day,
      serviceIds: q.services,
      preferredStaffId: q.staffId ?? null,
    });
  }
}
