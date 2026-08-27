import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  WaitlistHandler,
  type AcceptView,
  type JoinView,
} from '@application/commands/waitlist.handler';
import { CurrentActor } from '../../auth/actor.decorator';
import type { Actor } from '../../auth/actor';
import { DAY_START_MIN, DAY_END_MIN } from '@domain/availability/grid';

export class JoinWaitlistDto {
  @ApiProperty({ example: 'marina-walk' })
  @IsString()
  branchId!: string;

  @ApiProperty({ example: 'full-colour' })
  @IsString()
  serviceId!: string;

  @ApiProperty({ example: '2026-12-07' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be YYYY-MM-DD' })
  day!: string;

  @ApiProperty({
    example: 840,
    description:
      'When they can ARRIVE, earliest. Minutes from midnight, so 840 is 14:00.',
  })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  windowFromMin!: number;

  @ApiProperty({
    example: 1080,
    description:
      'And latest. A visit that runs past this is fine: the window says when ' +
      'they can arrive, not when they must be finished.',
  })
  @IsInt()
  @Min(DAY_START_MIN)
  @Max(DAY_END_MIN)
  windowToMin!: number;

  @ApiPropertyOptional({
    example: 'maya',
    description: 'Leave it out for "any professional", which matches more.',
  })
  @IsOptional()
  @IsString()
  preferredStaffId?: string;

  @ApiPropertyOptional({
    description: 'Staff booking on behalf of someone. Ignored for a customer.',
  })
  @IsOptional()
  @IsString()
  customerId?: string;
}

@ApiTags('waitlist')
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly handler: WaitlistHandler) {}

  @Post()
  @ApiOperation({
    summary: 'Join the list for a day that is full',
    description:
      'When a matching slot frees up, the top candidate gets fifteen minutes ' +
      'to take it before it passes down.',
  })
  @ApiCreatedResponse({
    description: 'Joined, with the position in the queue.',
  })
  @ApiConflictResponse({ description: 'The window is not a window.' })
  join(
    @Body() dto: JoinWaitlistDto,
    @CurrentActor() actor: Actor,
  ): Promise<JoinView> {
    return this.handler.join({
      branchId: dto.branchId,
      // A customer joins for themselves. Staff join on behalf of someone,
      // the same rule the hold and confirm endpoints already follow.
      customerId:
        actor.kind === 'customer' ? actor.id : (dto.customerId ?? actor.id),
      serviceId: dto.serviceId,
      tradingDay: dto.day,
      windowFromMin: dto.windowFromMin,
      windowToMin: dto.windowToMin,
      preferredStaffId: dto.preferredStaffId ?? null,
    });
  }

  @Post(':id/accept')
  @ApiOperation({
    summary: 'Take the offered slot',
    description:
      'Places an ordinary hold and returns its id. Confirm it through ' +
      'POST /bookings as normal: the requirement is resolved FRESH, so an ' +
      'acceptance that triggers a deposit lands as PendingPayment with the ' +
      'link, not as a free confirmation.',
  })
  @ApiOkResponse({ description: 'Held. Confirm it like any other booking.' })
  @ApiNotFoundResponse({ description: 'The offer expired or was taken.' })
  accept(@Param('id') id: string): Promise<AcceptView> {
    return this.handler.accept(id);
  }

  @Post(':id/decline')
  @ApiOperation({
    summary: 'Turn the slot down',
    description:
      'Passes it to the next person. Three declines and offers stop for this ' +
      'window, so one person holding out cannot absorb every slot.',
  })
  @ApiOkResponse({ description: 'Passed down.' })
  @ApiNotFoundResponse({ description: 'The offer expired.' })
  decline(@Param('id') id: string): Promise<{ message: string }> {
    return this.handler.decline(id);
  }
}
