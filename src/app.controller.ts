import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthGuard } from './auth/auth.guard';
import { CurrentUser } from './auth/current-user.decorator';
import { Identity } from './auth/auth.service';

@Controller()
export class AppController {
  @Get('api/v1/me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: Identity) {
    return user;
  }
}
