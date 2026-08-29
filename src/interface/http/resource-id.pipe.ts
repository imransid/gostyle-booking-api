import { NotFoundException, ParseUUIDPipe } from '@nestjs/common';

/**
 * A path segment that must be a resource id.
 *
 * WHY NOT THE BARE ParseUUIDPipe. A parameterised route swallows every path
 * that reaches its depth, so `GET /v1/bookings/settings` matches
 * `@Get(':id')` with id = "settings" and the plain pipe answers
 * "Validation failed (uuid is expected)" with a 400.
 *
 * That message is wrong twice over. The caller's id is not malformed — there
 * is no such route — and a 400 says "fix your input" when the honest answer
 * is "that is not here". It sent one reader hunting for a route-ordering bug
 * that did not exist, which is exactly the cost of a misleading error.
 *
 * 404 is right for both cases this pipe sees: a segment that is not an id at
 * all (a route that does not exist) and a well-formed request naming an id
 * that cannot exist. Neither is a resource this API has.
 *
 * NOTE: Express 5 removed inline regex route params, so constraining the
 * route itself (`:id([0-9a-f-]{36})`) is not available — it fails at boot on
 * path-to-regexp v8. Verified, not assumed.
 */
export const ResourceIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new NotFoundException(
      'No such resource. That path segment is not a resource id, so either ' +
        'the id is wrong or the route does not exist.',
    ),
});
