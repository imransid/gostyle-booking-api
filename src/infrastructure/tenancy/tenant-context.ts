import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the current request belongs to, for the length of that request.
 *
 * WHY A CONTEXT AND NOT A PARAMETER. The tenant is needed at the bottom of
 * the stack (the INSERT) and known at the top (the header), and it is the
 * same value for every write in the request. Threading it through six
 * controllers, their handlers and their repositories would be about forty
 * signatures, and the one that gets forgotten is the one that writes a row
 * with no tenant -- silently, because the column is nullable on purpose.
 *
 * AsyncLocalStorage is the narrow exception to this codebase's habit of
 * passing things down explicitly. It is justified here because the value is
 * REQUEST-SCOPED AMBIENT INFRASTRUCTURE rather than a domain input: no rule
 * reads it, nothing branches on it, and it never reaches the domain layer at
 * all. A domain input in here would be the mistake this comment exists to
 * prevent.
 */
@Injectable()
export class TenantContext {
  private readonly store = new AsyncLocalStorage<string | null>();

  /** Run fn with this tenant in scope. */
  run<T>(tenantId: string | null, fn: () => T): T {
    return this.store.run(tenantId, fn);
  }

  /**
   * The tenant for the current request, or null.
   *
   * Null is a legitimate answer, not an error: a caller that sends no header
   * and holds a token with no tenantId claim writes untenanted rows, exactly
   * as every row written before this feature existed.
   */
  current(): string | null {
    return this.store.getStore() ?? null;
  }
}

/**
 * The header the platform sends.
 *
 * Bounded and trimmed here so a malformed value never reaches the INSERT --
 * the CHECK constraint in the migration is the backstop, not the first line
 * of defence, and a 500 from a constraint is a worse answer than ignoring a
 * header nobody should have sent.
 */
export const TENANT_HEADER = 'x-tenant-id';

export const MAX_TENANT_ID_LENGTH = 64;

export function readTenantHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_TENANT_ID_LENGTH) return null;
  return trimmed;
}
