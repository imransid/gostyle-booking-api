import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  TenantContext,
  TENANT_HEADER,
  readTenantHeader,
} from './tenant-context';

/**
 * Opens the tenant scope for one request.
 *
 * MIDDLEWARE, NOT AN INTERCEPTOR, and the reason is AsyncLocalStorage rather
 * than taste. An interceptor returns an Observable that Nest subscribes to
 * AFTER intercept() has returned -- by which time the `run()` callback has
 * already exited and the store is gone. The handler would read null every
 * time, and would do it silently, because null is a legitimate answer here.
 * Middleware wraps next(), so the whole downstream runs inside the scope.
 *
 * Middleware runs BEFORE the guard, so the token has not been verified yet
 * and only the header can be read here. The scope opens with whatever the
 * header said -- possibly nothing -- and BookingAuthGuard fills it from the
 * token's tenantId claim once the signature checks out
 * (`TenantContext.fillFromToken`). The header still wins when it is present;
 * the token only answers when it is not.
 *
 * This comment used to say the claim could not be a fallback at all, and the
 * cost was a desk user holding a perfectly good token with no tenant: every
 * tenant-scoped platform lookup was refused, and the calendar drew six
 * fixture stylists at a branch with three real ones. A caller chooses the
 * header; the token is the one thing a caller cannot choose -- the same
 * reason the branch reads the token (branch-context.ts).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenants: TenantContext) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = readTenantHeader(req.headers[TENANT_HEADER]);
    this.tenants.run(tenantId, () => next());
  }
}
