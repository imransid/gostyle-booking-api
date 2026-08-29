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
 * The cost of that choice is that middleware runs BEFORE the guard, so
 * request.actor does not exist yet and the token's tenantId claim cannot be
 * a fallback. That is acceptable: the instruction is to populate from
 * X-Tenant-Id, and a header the platform controls is a better source than a
 * claim baked into a token hours ago.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenants: TenantContext) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = readTenantHeader(req.headers[TENANT_HEADER]);
    this.tenants.run(tenantId, () => next());
  }
}
