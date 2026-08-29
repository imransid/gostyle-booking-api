import { Body, Controller, Post } from '@nestjs/common';
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
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { WireEnum } from './wire-enum.decorator';
import {
  GetQuoteHandler,
  type QuoteView,
} from '@application/queries/get-quote.handler';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';
import { unshout } from '@application/contract/wire';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The domain words the shouted request enum folds back down to. */
const CHANNELS = ['desk', 'online'] as const;

export class QuoteDto {
  @ApiPropertyOptional({ example: 'marina-walk', default: 'marina-walk' })
  @IsOptional()
  @IsString()
  branchId: string = 'marina-walk';

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DAY, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: ['full-colour'],
    type: [String],
    description: 'Service ids, package ids, or a mix. Packages expand.',
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'pick at least one service' })
  @IsString({ each: true })
  serviceIds!: string[];

  @ApiProperty({ example: 'dana' })
  @IsString()
  customerId!: string;

  @ApiPropertyOptional({ enum: ['DESK', 'ONLINE'], default: 'DESK' })
  @IsOptional()
  @WireEnum(['DESK', 'ONLINE'])
  channel: 'DESK' | 'ONLINE' = 'DESK';

  @ApiPropertyOptional({
    example: 900,
    default: 900,
    description:
      'Minutes from midnight. Only the peak-window rung reads it, so a ' +
      'quote for an unchosen time still needs a plausible one.',
  })
  @IsOptional()
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN - 1)
  startMin: number = 900;
}

/**
 * The whole arithmetic, before anything is held or charged.
 *
 * Under /v1/bookings and in its own controller, registered ahead of
 * BookingsController — see the note on SettingsController for why.
 */
@ApiTags('bookings')
@Controller('bookings')
export class QuoteController {
  constructor(private readonly handler: GetQuoteHandler) {}

  @Post('quote')
  @ApiOperation({
    summary: 'Price a basket without booking it',
    description:
      'Returns every figure the arithmetic passes through, not just the ' +
      'three a caller usually wants. Note the two DIFFERENT bases: VAT is ' +
      'charged on the discounted subtotal, the deposit is computed on the ' +
      'pre-discount total. Both are returned so the numbers can be checked.',
  })
  @ApiOkResponse({ description: 'The quote, with the requirement trace.' })
  @ApiNotFoundResponse({
    description: 'One of the service ids does not exist.',
  })
  quote(@Body() dto: QuoteDto): Promise<QuoteView> {
    return this.handler.execute({
      branchId: dto.branchId,
      tradingDay: dto.day,
      serviceIds: dto.serviceIds,
      customerId: dto.customerId,
      channel: unshout(dto.channel, CHANNELS)!,
      startMin: dto.startMin,
    });
  }
}
