/**
 * TODO: one sentence, in the salon's own words, saying what this is.
 *
 * PURE. No async, no Prisma, no Nest, no clock. Everything arrives as an
 * argument, which is why the spec beside this file needs no setup at all.
 *
 * A business refusal is RETURNED as a union keyed on 'kind', never thrown.
 * This layer does not know HTTP exists, so it cannot know a refusal should
 * become a 403 or a 409. It states the fact; the handler picks the status.
 */

import type { ActorKind } from '@domain/booking/lifecycle';

export const MAX_STYLIST_LABEL = 200;

export type StylistStatus = 'active' | 'archived';

export const STYLIST_STATUSES: readonly StylistStatus[] = [
  'active',
  'archived',
];

export type LabelResult =
  | { readonly kind: 'ok'; readonly label: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Tidy the label and say whether it is usable.
 *
 * Returns the trimmed text rather than changing anything in place, so the
 * caller stores exactly what was approved and never the raw input.
 */
export function cleanStylistLabel(raw: string): LabelResult {
  const label = raw.trim();

  if (label.length === 0) {
    return { kind: 'refused', reason: 'A label cannot be empty.' };
  }
  if (label.length > MAX_STYLIST_LABEL) {
    return { kind: 'refused', reason: 'That label is too long.' };
  }
  return { kind: 'ok', label };
}

export interface ModifyRequest {
  /** Who created the record. */
  readonly authorId: string;
  /** Who is asking to change it now. */
  readonly actorId: string;
  readonly actorKind: ActorKind;
}

export type ModifyDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * You may change your own. A manager may change anyone's.
 *
 * Other staff are refused on purpose: a record of what one person did should
 * not be quietly rewritten by a colleague. Change this if the salon's rule
 * is different — but change it HERE, not in the handler.
 */
export function mayModifyStylist(req: ModifyRequest): ModifyDecision {
  if (req.actorKind === 'manager') return { kind: 'allowed' };
  if (req.actorId === req.authorId) return { kind: 'allowed' };
  return {
    kind: 'refused',
    reason: 'Only the author or a manager may change this.',
  };
}
