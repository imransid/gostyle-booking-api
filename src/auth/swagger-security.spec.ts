import { describe, it, expect } from 'vitest';
import { Controller, Get } from '@nestjs/common';
import { PUBLIC_KEY } from './booking-auth.guard';
import { Public } from './public.decorator';

/**
 * The Authorize button used to do nothing.
 *
 * `addBearerAuth()` DEFINES a security scheme; it does not APPLY it. So the
 * button rendered, accepted a token, stored it, and attached it to no
 * request, because Swagger UI only sends a credential to operations that
 * declare they want one. Every lock icon stayed open and every call came back
 * "Missing bearer token" while the identical request through curl worked.
 *
 * The fix is a document-level requirement in main.ts, mirroring the global
 * guard, with @Public() carrying the matching opt-out so one decorator still
 * governs both. That leaves one way to regress: someone simplifies Public()
 * back to a bare SetMetadata, the guard keeps working, and /docs quietly
 * starts claiming /health needs a bearer token. Nothing would fail. Hence
 * this file.
 *
 * The metadata is read off a real decorated class rather than asserted
 * against a hard-coded key name, so it stays true if @nestjs/swagger renames
 * its internals.
 */

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(this: void): string {
    return 'open';
  }

  @Get('closed')
  closed(this: void): string {
    return 'closed';
  }
}

/** Every metadata key the decorators left on a handler. */
const keysOn = (fn: object): string[] =>
  (Reflect.getMetadataKeys(fn) as unknown[]).map((k) => String(k));

const open = ProbeController.prototype.open;
const closed = ProbeController.prototype.closed;

describe('@Public() opens the guard AND the OpenAPI operation', () => {
  it('sets the guard metadata the APP_GUARD reads', () => {
    expect(Reflect.getMetadata(PUBLIC_KEY, open)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_KEY, closed)).toBeUndefined();
  });

  it('ALSO sets swagger security metadata, which is the half that regressed', () => {
    const added = keysOn(open).filter((k) => !keysOn(closed).includes(k));
    const securityKey = added.find((k) => k.toLowerCase().includes('security'));
    expect(
      securityKey,
      `@Public() left only ${JSON.stringify(added)} beyond the plain handler. ` +
        'It must also apply a swagger security override, or /docs will show a ' +
        'closed lock on every public route and demand a token for /health.',
    ).toBeDefined();
  });

  it('and that override is an EMPTY requirement: auth optional, not required', () => {
    // OpenAPI 3 §4.8.30.1: an empty object in the security array satisfies
    // the requirement on its own. That is how a route says "a token is
    // accepted here but not needed" -- which is exactly what @Public() means,
    // since these routes still read a token when one is sent.
    const securityKey = keysOn(open).find((k) =>
      k.toLowerCase().includes('security'),
    )!;
    const value = Reflect.getMetadata(securityKey, open) as unknown;
    expect(Array.isArray(value)).toBe(true);
    const requirements = value as Record<string, unknown>[];
    expect(requirements).toHaveLength(1);
    expect(Object.keys(requirements[0]!)).toHaveLength(0);
  });
});
