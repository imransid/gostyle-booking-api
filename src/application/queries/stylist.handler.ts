/**
 * The choreographer. Every method below is the same three beats:
 *
 *     fetch (infrastructure) -> decide (domain) -> act (infrastructure)
 *
 * This is also the ONLY layer that knows a refusal becomes an HTTP status.
 *
 * A plain @Injectable class. NOT @nestjs/cqrs — the package sits in
 * package.json but no bus is wired anywhere, so a @CommandHandler dispatched
 * through a CommandBus would never be discovered and would fail at injection.
 */

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  StylistRepository,
  type StylistRow,
} from '@infrastructure/persistence/stylist.repository';
import {
  cleanStylistLabel,
  mayModifyStylist,
  type StylistStatus,
} from '@domain/shared/stylist';
import type { ActorKind } from '@domain/booking/lifecycle';
import { shout, type Shouted } from '@application/contract/wire';

export interface StylistActor {
  readonly id: string;
  readonly kind: ActorKind;
}

export interface StylistQuery {
  readonly branchId: string;
  readonly label: string;
}

/**
 * What the client sees. Enums leave SCREAMING_SNAKE and dates leave as ISO
 * strings — the front end should never receive a JS Date or a lowercase
 * status word.
 */
export interface StylistView {
  readonly id: string;
  readonly branchId: string;
  readonly label: string;
  readonly status: Shouted<StylistStatus>;
  readonly authorId: string;
  readonly createdAt: string;
}

export function toStylistView(row: StylistRow): StylistView {
  return {
    id: row.id,
    branchId: row.branchId,
    label: row.label,
    status: shout(row.status),
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class StylistHandler {
  constructor(private readonly repo: StylistRepository) {}

  // ── CREATE ────────────────────────────────────────────────────────────
  async create(
    input: StylistQuery,
    actor: StylistActor,
  ): Promise<StylistView | null> {
    // DECIDE first. Never write something the rule has not approved.
    const cleaned = cleanStylistLabel(input.label);
    if (cleaned.kind === 'refused') {
      throw new ConflictException(cleaned.reason);
    }

    // ACT. Note it stores cleaned.label, not input.label.
    const row = await this.repo.create({
      branchId: input.branchId,
      label: cleaned.label,
      authorId: actor.id,
    });

    return row === null ? null : toStylistView(row);
  }

  // ── READ ──────────────────────────────────────────────────────────────
  /**
   * No rule to ask. Plenty of reads are pure fetching, and inventing a
   * domain function that only ever returns 'allowed' would be ceremony.
   */
  async list(branchId: string): Promise<readonly StylistView[]> {
    const rows = await this.repo.listFor(branchId);
    return rows === null ? [] : rows.map(toStylistView);
  }

  async findOne(id: string): Promise<StylistView | null> {
    const row = await this.repo.find(id);
    if (row === null) {
      throw new NotFoundException('No such stylist.');
    }
    return row === null ? null : toStylistView(row);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  async update(
    id: string,
    label: string,
    actor: StylistActor,
  ): Promise<StylistView | null> {
    // FETCH — the rule needs to know who created it.
    const existing = await this.repo.find(id);
    if (existing === null) {
      throw new NotFoundException('No such stylist.');
    }

    // DECIDE — permission.
    const permission = mayModifyStylist({
      authorId: existing.authorId,
      actorId: actor.id,
      actorKind: actor.kind,
    });
    if (permission.kind === 'refused') {
      throw new ForbiddenException(permission.reason);
    }

    // DECIDE — content.
    const cleaned = cleanStylistLabel(label);
    if (cleaned.kind === 'refused') {
      throw new ConflictException(cleaned.reason);
    }

    // ACT.
    await this.repo.update(id, cleaned.label);
    return null;
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  async remove(id: string, actor: StylistActor): Promise<{ message: string }> {
    const existing = await this.repo.find(id);
    if (existing === null) {
      throw new NotFoundException('No such stylist.');
    }

    const permission = mayModifyStylist({
      authorId: existing.authorId,
      actorId: actor.id,
      actorKind: actor.kind,
    });
    if (permission.kind === 'refused') {
      throw new ForbiddenException(permission.reason);
    }

    await this.repo.remove(id);
    return { message: 'Removed.' };
  }
}
