import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Asia/Dubai is UTC+4 all year. A branch with DST would need a real tz lib. */
const BRANCH_UTC_OFFSET_MIN = 240;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fixture slugs like "maya" are not UUIDs, but the columns are.
 *
 * Real ids arrive from the platform as UUIDs and pass through untouched.
 * A slug is folded into a deterministic UUID so the fixture stays readable
 * without weakening the column type. This disappears when the gRPC adapters
 * land, because then every id really is a UUID.
 */
export function toUuid(id: string): string {
  if (UUID_RE.test(id)) return id.toLowerCase();

  let h1 = 0xdeadbeefn;
  let h2 = 0x41c6ce57n;
  const M = (1n << 64n) - 1n;
  for (let i = 0; i < id.length; i++) {
    const c = BigInt(id.charCodeAt(i));
    h1 = ((h1 ^ c) * 1099511628211n) & M;
    h2 = ((h2 + c) * 1099511628211n) & M;
  }
  const hex =
    h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '8' + hex.slice(13, 16), // version nibble, kept valid
    ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16) +
      hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Trading day plus minute of day, as a real instant. */
export function branchInstant(tradingDay: string, minuteOfDay: number): Date {
  const [y, m, d] = tradingDay.split('-').map(Number);
  const midnightUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(midnightUtc + (minuteOfDay - BRANCH_UTC_OFFSET_MIN) * 60_000);
}

export interface ResourceDemand {
  readonly resourceType: string;
  readonly startMin: number;
  readonly endMin: number;
  /** Effective units at this branch, after out-of-service. */
  readonly units: number;
}

export interface PlaceHoldInput {
  readonly branchId: string;
  readonly customerId: string | null;
  readonly tradingDay: string;
  readonly staffId: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly claimPreMin: number;
  readonly claimPostMin: number;
  readonly processing?: { readonly fromMin: number; readonly toMin: number };
  readonly resourceDemand: readonly ResourceDemand[];
  readonly feasibilityToken: string;
  readonly ttlMs: number;
}

export type PlaceHoldOutcome =
  | { readonly kind: 'held'; readonly holdId: string; readonly expiresAt: Date }
  /** The exclusion constraint refused. Someone else has this professional. */
  | { readonly kind: 'staff_taken' }
  /** Every unit of this chair type is in use for the window. */
  | {
      readonly kind: 'no_chair';
      readonly resourceType: string;
      readonly inUse: number;
      readonly units: number;
    };

/** Postgres exclusion violation. Prisma has no typed code for 23P01. */
/**
 * Postgres SQLSTATE 23P01, exclusion_violation.
 *
 * Prisma 7 reports it as its own P2039 and buries the real code three levels
 * down, so the path is worth spelling out rather than pattern-matching text:
 *
 *   PrismaClientKnownRequestError
 *     .code                                  "P2039"
 *     .meta.driverAdapterError.cause.code    "23P01"   <- the truth
 *
 * An earlier version of this matched `message.includes('exclusion constraint')`
 * and quietly reported a dead connection pool as "someone took your slot".
 * A wrong business answer is worse than a 500, because nobody investigates
 * a 409. Match the code, and let anything unrecognised throw.
 */
function isExclusionViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;

  const direct = (e as { code?: unknown }).code;
  if (direct === '23P01') return true;

  const cause = (
    e as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } }
  ).meta?.driverAdapterError?.cause?.code;

  return cause === '23P01';
}

@Injectable()
export class HoldRepository {
  private static readonly log = new Logger(HoldRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Place a hold, atomically, or explain why not.
   *
   * Two different protections, because staff and chairs are different shapes
   * of problem:
   *
   *   staff  -> the EXCLUDE constraint. "Maya cannot be in two places" is a
   *             property of a pair of rows, so Postgres enforces it and the
   *             second insert simply fails. No lock needed.
   *
   *   chairs -> an ADVISORY LOCK plus a count. "Fewer than two in use" is not
   *             a property of any row, so no constraint can express it. The
   *             count and the insert have to be atomic together, or two desks
   *             both read "one free" at the same instant and both take it.
   *
   * The lock key is per branch, per resource type, per day. Booking a nail
   * appointment never waits on a colour appointment.
   */
  async place(input: PlaceHoldInput): Promise<PlaceHoldOutcome> {
    const startAt = branchInstant(input.tradingDay, input.startMin);
    const endAt = branchInstant(
      input.tradingDay,
      input.startMin + input.durationMin,
    );
    const expiresAt = new Date(Date.now() + input.ttlMs);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Take the turn, one resource type at a time, in a stable order so
        //    two transactions can never deadlock by locking in opposite orders.
        const types = [
          ...new Set(input.resourceDemand.map((r) => r.resourceType)),
        ].sort();
        for (const type of types) {
          const key = `${input.branchId}:${type}:${input.tradingDay}`;
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        }

        // 2. Now the count is trustworthy, because nobody else can be counting.
        for (const demand of input.resourceDemand) {
          const from = branchInstant(input.tradingDay, demand.startMin);
          const to = branchInstant(input.tradingDay, demand.endMin);

          const rows = await tx.$queryRaw<{ in_use: bigint }[]>`
            SELECT count(*) AS in_use
              FROM resource_reservation
             WHERE blocking
               AND branch_id = ${toUuid(input.branchId)}::uuid
               AND resource_type = ${demand.resourceType}
               AND trading_day = ${input.tradingDay}::date
               AND tstzrange(start_at, end_at, '[)')
                && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`;

          const inUse = Number(rows[0]?.in_use ?? 0);
          if (inUse >= demand.units) {
            // Throwing rolls the transaction back and releases the lock.
            throw new NoChairError(demand.resourceType, inUse, demand.units);
          }
        }

        // 3. The hold itself.
        const hold = await tx.hold.create({
          data: {
            branchId: toUuid(input.branchId),
            customerId:
              input.customerId === null ? null : toUuid(input.customerId),
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            feasibilityToken: input.feasibilityToken,
            expiresAt,
          },
          select: { id: true, expiresAt: true },
        });

        // 4. Staff time. THE EXCLUSION CONSTRAINT DECIDES HERE.
        await tx.staffReservation.create({
          data: {
            holdId: hold.id,
            branchId: toUuid(input.branchId),
            staffId: toUuid(input.staffId),
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            kind: 'active',
            startAt,
            endAt,
            startMinute: input.startMin,
            durationMin: input.durationMin,
            claimPreMin: input.claimPreMin,
            claimPostMin: input.claimPostMin,
            processingFromMin: input.processing?.fromMin ?? null,
            processingToMin: input.processing?.toMin ?? null,
          },
        });

        // 5. Chair time, one row per segment that actually holds a chair.
        await tx.resourceReservation.createMany({
          data: input.resourceDemand.map((d) => ({
            holdId: hold.id,
            branchId: toUuid(input.branchId),
            resourceType: d.resourceType,
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            startAt: branchInstant(input.tradingDay, d.startMin),
            endAt: branchInstant(input.tradingDay, d.endMin),
            startMinute: d.startMin,
            durationMin: d.endMin - d.startMin,
          })),
        });

        return { kind: 'held', holdId: hold.id, expiresAt: hold.expiresAt };
      });
    } catch (e) {
      HoldRepository.log.error(
        'place() failed. shape: ' +
          JSON.stringify(
            {
              ctor: (e as { constructor?: { name?: string } })?.constructor
                ?.name,
              code: (e as { code?: unknown })?.code,
              meta: (e as { meta?: unknown })?.meta,
              causeCode: (e as { cause?: { code?: unknown } })?.cause?.code,
              message: e instanceof Error ? e.message.slice(0, 500) : String(e),
            },
            null,
            2,
          ),
      );
      if (e instanceof NoChairError) {
        return {
          kind: 'no_chair',
          resourceType: e.resourceType,
          inUse: e.inUse,
          units: e.units,
        };
      }
      if (isExclusionViolation(e)) {
        // Not an error. Someone else got there first, which is a normal
        // outcome the operator is told about in plain language.
        return { kind: 'staff_taken' };
      }
      throw e;
    }
  }

  /**
   * Release a hold. The reservations go with it through ON DELETE CASCADE,
   * so capacity returns in the same statement.
   */
  async release(holdId: string): Promise<boolean> {
    const { count } = await this.prisma.hold.deleteMany({
      where: { id: holdId },
    });
    return count > 0;
  }

  /** Alive means not yet expired. A dead hold protects nothing. */
  async findAlive(holdId: string, nowMs: number = Date.now()) {
    return this.prisma.hold.findFirst({
      where: { id: holdId, expiresAt: { gt: new Date(nowMs) } },
      include: { staffReservations: true, resourceReservations: true },
    });
  }

  /** The sweep the worker runs. Capacity returns the moment a TTL lapses. */
  async sweepExpired(nowMs: number = Date.now()): Promise<number> {
    const { count } = await this.prisma.hold.deleteMany({
      where: { expiresAt: { lte: new Date(nowMs) } },
    });
    if (count > 0) HoldRepository.log.log(`Swept ${count} expired hold(s)`);
    return count;
  }
}

class NoChairError extends Error {
  constructor(
    readonly resourceType: string,
    readonly inUse: number,
    readonly units: number,
  ) {
    super(`no ${resourceType} free (${inUse} of ${units} in use)`);
  }
}
