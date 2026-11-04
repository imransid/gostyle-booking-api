import { Controller, Get, HttpCode, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MobilePackagesHandler } from '@application/queries/mobile-packages.handler';
import { MobileContractError } from '@application/commands/mobile-booking.error';

/**
 * The packages a salon sells, for the app's picker.
 *
 * Auth is the global guard, as on every other mobile route. The ids returned
 * are what the app sends back in `services[].id` on POST /v1/mobile-booking.
 */
@ApiTags('mobile')
@Controller('mobile-packages')
export class MobilePackagesController {
  constructor(private readonly handler: MobilePackagesHandler) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Packages sold at a salon',
    description:
      'Each package with its net price, the parts total, the saving and ' +
      'its parts. A package that cannot be priced is left out, not fatal.',
  })
  @ApiQuery({ name: 'salon_id', required: true })
  @ApiOkResponse({ description: '{ count, results: [package] }' })
  list(@Query('salon_id') salonId?: string): Promise<unknown> {
    if (!salonId) {
      throw MobileContractError.of(
        'salon_id',
        'invalid_window',
        'salon_id is required.',
      );
    }
    return this.handler.list(salonId);
  }
}
