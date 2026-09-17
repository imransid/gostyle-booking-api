import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  BRANCH_HEADER,
  readBranchHeader,
  resolveBranch,
} from '@infrastructure/tenancy/branch-context';

/**
 * The branch for this request, resolved once.
 *
 * `@BranchId() branchId: string` in a controller signature replaces
 * `dto.branchId ?? 'marina-walk'`, and gets the header's answer when one was
 * sent. Pass the DTO's own field as the argument where a route still accepts
 * one in the body:
 *
 *     list(@Query() q: ListDto, @BranchId(q.branchId) branchId: string)
 *
 * Reading the header off the request rather than out of BranchContext keeps
 * this usable in tests that never ran the middleware.
 */
export const BranchId = createParamDecorator(
  (fromBody: string | undefined, ctx: ExecutionContext): string => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    return resolveBranch({
      header: readBranchHeader(req.headers[BRANCH_HEADER]),
      fromBody,
    });
  },
);
