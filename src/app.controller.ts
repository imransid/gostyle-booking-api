import { Controller, Get, Headers } from '@nestjs/common';
import { AuthService } from './auth/auth.service';

@Controller()
export class AppController {
  constructor(private readonly auth: AuthService) {}

  @Get('api/v1/me')
  async me(@Headers('authorization') header?: string) {
    if (!header?.startsWith('Bearer ')) {
      return { error: 'no token' };
    }

    const token = header.slice('Bearer '.length);
    const identity = await this.auth.verifyToken(token);

    return identity ?? { error: 'invalid token' };
  }
}
