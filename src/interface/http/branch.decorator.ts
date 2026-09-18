import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { resolveBranchForRequest } from '@infrastructure/tenancy/branch-context';
import type { RequestWithActor } from '../../auth/booking-auth.guard';

/**
 * The branch for this request, resolved once.
 *
 * `@BranchId() branchId: string` in a controller signature replaces
 * `dto.branchId ?? 'marina-walk'` AND the token claim AND the header, in the
 * one precedence chain that `branch-context.ts` documents. It reads the body
 * and query itself rather than taking the field as an argument -- a decorator
 * argument is evaluated once at class-definition time, so the old
 * `@BranchId(dto.branchId)` spelling in the doc comment could never have
 * worked and nothing ever used it.
 *
 * Pass a field name only where a route spells the branch something else:
 *
 *     seat(@BranchId('salonId') branchId: string)
 *
 * Reading off the request rather than out of BranchContext keeps this usable
 * in tests that never ran the middleware.
 */
export const BranchId = createParamDecorator(
  (field: string | undefined, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    return resolveBranchForRequest(req, field ?? 'branchId').branchId;
  },
);
