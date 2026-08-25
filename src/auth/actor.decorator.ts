import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Actor } from './actor';
import type { RequestWithActor } from './booking-auth.guard';

/**
 * Pull the verified caller into a handler:
 *
 *   confirm(@Body() dto: Dto, @CurrentActor() actor: Actor)
 *
 * The guard has already run, so this is never undefined on a protected
 * route. On a @Public() one it can be, hence the optional type.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor | undefined =>
    ctx.switchToHttp().getRequest<RequestWithActor>().actor,
);
