/**
 * Rows in, rows out. Every method here is an await on Postgres and nothing
 * else. It has no opinion about whether any of it is allowed — the handler
 * already asked the rule before calling.
 *
 * NEVER inject an application port here. The handler owns the ports and
 * passes down whatever answer they gave.
 *
 * TENANT SCOPING is why find() uses findFirst rather than findUnique: a row
 * belonging to another salon must come back as null so the handler answers
 * 404, not 403. A 403 would confirm the id exists.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import type { StylistStatus } from '@domain/shared/stylist';

export interface StylistRow {
  readonly id: string;
  readonly branchId: string;
  readonly label: string;
  readonly status: StylistStatus;
  readonly authorId: string;
  readonly createdAt: Date;
}

@Injectable()
export class StylistRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  /** The request's tenant, or null. See tenancy/tenant-context.ts. */
  private tenantId(): string | null {
    return this.tenants.current();
  }

  static row(r: {
    id: string;
    branchId: string;
    label: string;
    status: string;
    authorId: string;
    createdAt: Date;
  }): StylistRow {
    return { ...r, status: r.status as StylistStatus };
  }

  // STUB BODIES until the `stylist` model exists. Each method takes the
  // arguments its commented-out query needs and awaits nothing, which lint
  // rightly calls unused. Delete this line with the comments the day the
  // queries are uncommented; nothing else in the file is exempt.
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  // ── CREATE ────────────────────────────────────────────────────────────
  async create(input: {
    readonly branchId: string;
    readonly label: string;
    readonly authorId: string;
  }): Promise<StylistRow | null> {
    // const row = await this.prisma.stylist.create({
    //   data: { ...input, tenantId: this.tenantId() },
    // });
    // return StylistRepository.row(row);
    return null;
  }

  // ── READ (many) ───────────────────────────────────────────────────────
  async listFor(branchId: string): Promise<readonly StylistRow[] | null> {
    // const rows = await this.prisma.stylist.findMany({
    //   where: { branchId, tenantId: this.tenantId() },
    //   orderBy: { createdAt: 'desc' },
    // });
    // return rows.map(StylistRepository.row);
    return null;
  }

  // ── READ (one) ────────────────────────────────────────────────────────
  async find(id: string): Promise<StylistRow | null> {
    return null;
    // const row = await this.prisma.stylist.findFirst({
    //   where: { id, tenantId: this.tenantId() },
    // });
    // return row === null ? null : StylistRepository.row(row);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  async update(id: string, label: string) {
    // const row = await this.prisma.stylist.update({
    //   where: { id },
    //   data: { label },
    // });
    // return StylistRepository.row(row);
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  /**
   * deleteMany, not delete, with the tenant in the where clause. delete()
   * throws when nothing matches; deleteMany returns a count, so a
   * cross-tenant id quietly removes nothing instead of exploding.
   */
  async remove(id: string): Promise<number | null> {
    // const { count } = await this.prisma.stylist.deleteMany({
    //   where: { id, tenantId: this.tenantId() },
    // });
    // return count;
    return null;
  }
}
