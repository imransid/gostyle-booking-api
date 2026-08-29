import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GetSettingsHandler,
  type SettingsView,
} from '@application/queries/get-settings.handler';

/**
 * Every number the front end would otherwise hard-code.
 *
 * Authenticated like everything else: these are operational parameters, not
 * public information, and a caller who cannot book has no reason to know the
 * deposit ceiling.
 */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly handler: GetSettingsHandler) {}

  @Get()
  @ApiOperation({
    summary: 'The constants the engine actually runs on',
    description:
      'Read straight from the modules that own each rule, so this can never ' +
      'drift from the behaviour. Money is in minor units. Nothing here ' +
      'varies by branch yet, and the scope field says so.',
  })
  @ApiOkResponse({ description: 'The full set.' })
  get(): SettingsView {
    return this.handler.execute();
  }
}
