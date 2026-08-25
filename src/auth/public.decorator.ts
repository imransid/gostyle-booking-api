import { SetMetadata } from '@nestjs/common';
import { PUBLIC_KEY } from './booking-auth.guard';

/**
 * Open this endpoint to anyone.
 *
 * Used on availability (a customer browsing times has not signed in yet) and
 * health (Swarm's probe carries no token). Everything else stays closed.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_KEY, true);
