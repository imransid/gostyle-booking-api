import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  BranchContext,
  BRANCH_HEADER,
  branchRequired,
  readBranchHeader,
} from './branch-context';
import { bookingError } from '@application/contract/errors';

/**
 * Opens the branch scope for one request.
 *
 * Middleware for the same reason TenantMiddleware is middleware: the scope
 * has to wrap next(), or AsyncLocalStorage is empty by the time a handler
 * reads it.
 *
 * The /health probe and the payment webhook are exempt from the mandatory
 * check. A gateway has no idea what a branch is, and a health probe that
 * needs a business header is a health probe that fails for the wrong reason.
 */
const EXEMPT = [/^\/health/, /^\/v1\/webhooks\//, /^\/docs/];

@Injectable()
export class BranchMiddleware implements NestMiddleware {
  constructor(private readonly branches: BranchContext) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const branchId = readBranchHeader(req.headers[BRANCH_HEADER]);

    if (
      branchId === null &&
      branchRequired() &&
      !EXEMPT.some((r) => r.test(req.path))
    ) {
      throw bookingError(
        'BOOKING_REASON_REQUIRED',
        'X-Branch-Id is required on every booking route.',
        { header: 'X-Branch-Id' },
      );
    }

    this.branches.run(branchId, () => next());
  }
}
