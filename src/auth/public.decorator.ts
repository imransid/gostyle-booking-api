import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';
import { PUBLIC_KEY } from './booking-auth.guard';

/**
 * Open this endpoint to anyone.
 *
 * Used on availability (a customer browsing times has not signed in yet) and
 * health (Swarm's probe carries no token). Everything else stays closed.
 *
 * TWO EFFECTS, ONE DECORATOR. It opens the guard, and it opens the OpenAPI
 * operation to match.
 *
 * The document declares `security: [{ bearer: [] }]` globally, mirroring the
 * global guard. An operation that the guard lets through therefore has to say
 * so, or /docs shows a closed lock on /health and a reader concludes the
 * probe needs a credential it has never sent.
 *
 * `ApiSecurity({})` emits an EMPTY security requirement object, which is how
 * OpenAPI 3 spells "authentication is optional here" (§4.8.30.1: an empty
 * object in the array satisfies the requirement on its own). Swagger UI reads
 * that and stops demanding a token for the operation. It is not the same as
 * deleting the key, and deliberately so: these routes still ACCEPT a token
 * when one is sent, which is exactly what an optional requirement describes.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(PUBLIC_KEY, true), ApiSecurity({}));
