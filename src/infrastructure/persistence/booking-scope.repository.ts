import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** What the scope rule needs to know about one booking, and what the log says. */
export interface ScopedBookingRow {
  readonly id: string;
  readonly code: string;
  readonly customerId: string;
  readonly tenantId: string | null;
  readonly branchId: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCOPE_FIELDS = {
  id: true,
  code: true,
  customerId: true,
  tenantId: true,
  branchId: true,
} as const;

/**
 * Whose booking is this: the lookup behind interface/http/booking-scope.ts.
 *
 * THE SAME ROW THE ROUTE WILL ACT ON. A scope check that looks up one row
 * and a handler that acts on another is no check at all, so each lookup
 * matches exactly the way its route's handler does:
 *
 *   by id    the id as a uuid, as every by-id handler casts it. A malformed
 *            id is null here and never reaches the cast, as before.
 *   by code  the code EXACTLY as sent: not trimmed, not case-folded.
 *            late-capture's handler matches `booking.code = $1` on the raw
 *            value, so any folding here could find a row the handler
 *            would not, or miss one it would.
 */
@Injectable()
export class BookingScopeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async byId(bookingId: string): Promise<ScopedBookingRow | null> {
    if (!UUID_RE.test(bookingId)) return null;
    return this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: SCOPE_FIELDS,
    });
  }

  async byCode(code: string): Promise<ScopedBookingRow | null> {
    if (code === '') return null;
    return this.prisma.booking.findUnique({
      where: { code },
      select: SCOPE_FIELDS,
    });
  }
}
