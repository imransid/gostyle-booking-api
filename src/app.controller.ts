import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentActor } from './auth/actor.decorator';
import type { Actor } from './auth/actor';

@ApiTags('auth')
@Controller()
export class AppController {
  // 'me', not 'api/v1/me'. main.ts sets the global prefix, so the version
  // belongs there and nowhere else; carrying it here too registered the
  // route at /v1/api/v1/me, which nothing has ever called.
  @Get('me')
  @ApiOperation({
    summary: 'Who this token is, as this service sees them',
    description:
      'Answers for BOTH token kinds, which is the fix: this route used to ' +
      'carry its own @UseGuards(AuthGuard) — the customer-only gRPC guard — ' +
      'while every other route in the service went through the global ' +
      'BookingAuthGuard. So a staff token that worked on all 102 other ' +
      'routes answered 401 UNAUTHENTICATED here, in the same second. It is ' +
      'the route people reach for to check a token, and it was the one route ' +
      'that could not.',
  })
  @ApiOkResponse({
    description:
      'The verified actor. `branchId` is the branch this token scopes every ' +
      'read to; null means all branches, which is a customer or a company ' +
      'owner.',
  })
  me(@CurrentActor() actor: Actor): Actor {
    // The GLOBAL guard already verified the bearer and put the actor on the
    // request, so there is nothing to guard here a second time. Removing the
    // extra decorator is the whole change.
    return actor;
  }
}
