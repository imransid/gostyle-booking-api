import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthGuard } from './auth/auth.guard';
import { CurrentUser } from './auth/current-user.decorator';
import { Identity } from './auth/auth.service';

@Controller()
export class AppController {
  // 'me', not 'api/v1/me'. main.ts sets the global prefix, so the version
  // belongs there and nowhere else; carrying it here too registered the
  // route at /v1/api/v1/me, which nothing has ever called.
  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: Identity) {
    return user;
  }
}
