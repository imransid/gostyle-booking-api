import type { Request } from 'express';
import type { Identity } from './auth.service';

/**
 * An Express request after AuthGuard has run.
 *
 * `user` is optional because the raw request genuinely does not have it:
 * the guard puts it there. Making it required would be a lie the compiler
 * would happily believe, and every handler would then trust a field that
 * is undefined on any route missing @UseGuards(AuthGuard).
 */
export interface AuthenticatedRequest extends Request {
  user?: Identity;
}
