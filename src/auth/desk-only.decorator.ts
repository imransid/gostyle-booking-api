import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { DESK_ONLY_KEY } from './booking-auth.guard';

/**
 * Close this endpoint to customers. The salon only.
 *
 * READ BY THE EXISTING GUARD, not by a second one. BookingAuthGuard already
 * resolves the Actor for every request, so the kind is in hand at the moment
 * the decision has to be made; a separate guard would have to be remembered
 * in a @UseGuards() on every controller, and the one that was forgotten
 * would fail open and silently. This mirrors @Public(), which is the same
 * shape in the other direction.
 *
 * TWO EFFECTS, ONE DECORATOR, for the same reason @Public() has two: the
 * guard refuses the call and /docs says the call can be refused. A 403 that
 * is undocumented is a 403 a client author discovers in production.
 */
export const DeskOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(DESK_ONLY_KEY, true),
    ApiForbiddenResponse({
      description: 'Salon staff only. A customer token is refused here.',
    }),
  );
