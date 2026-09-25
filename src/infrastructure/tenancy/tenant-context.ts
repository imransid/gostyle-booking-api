import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the current request belongs to, for the length of that request.
 *
 * WHY A CONTEXT AND NOT A PARAMETER. The tenant is needed at the bottom of
 * the stack (the INSERT) and known at the top (the header, or failing that
 * the verified token), and it is the same value for every write in the
 * request. Threading it through six
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
 *
 * A SLOT, NOT A BARE VALUE. The scope has to open in middleware, before the
 * guard has verified the token, so the only thing known at that point is the
 * header. The slot lets the guard fill the tenant in afterwards without
 * opening a second scope -- which it could not do anyway: a guard returns
 * before the handler runs, so a `run()` inside it would be over by then.
 * Every `run()` makes a fresh slot, so filling one request's tenant can never
 * reach another's.
 */
interface TenantSlot {
  tenantId: string | null;
}

@Injectable()
export class TenantContext {
  private readonly store = new AsyncLocalStorage<TenantSlot>();

  /** Run fn with this tenant in scope. */
  run<T>(tenantId: string | null, fn: () => T): T {
    return this.store.run({ tenantId }, fn);
  }

  /**
   * The tenant for the current request, or null.
   *
   * Null is a legitimate answer, not an error: a caller that sends no header
   * and holds a token with no tenantId claim writes untenanted rows, exactly
   * as every row written before this feature existed.
   */
  current(): string | null {
    return this.store.getStore()?.tenantId ?? null;
  }

  /**
   * Fill the tenant from the verified token -- ONLY if the header gave none.
   *
   * A FALLBACK, NEVER AN OVERRIDE. A header that is present already answered
   * and is left alone. When it is absent, a desk user's token names their
   * tenant, and ignoring it left every tenant-scoped platform lookup refused:
   * the calendar drew six fixture stylists at a branch with three real ones.
   * The branch already worked this way (branch-context.ts), and for the same
   * reason -- a caller chooses the header; the token is the one thing a
   * caller cannot choose.
   *
   * Bounded exactly as the header is, so a claim can never write a value the
   * header could not. A customer token carries no tenant and leaves null.
   * Outside a request scope there is nothing to fill, and it does nothing.
   */
  fillFromToken(tenantId: string | null | undefined): void {
    const slot = this.store.getStore();
    if (slot === undefined || slot.tenantId !== null) return;
    slot.tenantId = readTenantHeader(tenantId);
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
