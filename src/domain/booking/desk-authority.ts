import type { ActorKind } from './lifecycle';

/**
 * Who counts as the salon rather than a member of the public.
 *
 * Shared, not redeclared: `lifecycle.ts` builds its `allowedActors` lists
 * from this same constant, so "who is staff" has one answer. A second copy
 * would drift the moment a fourth kind is added, and the copy that lagged
 * would be the one guarding an endpoint.
 */
export const ANY_STAFF: readonly ActorKind[] = ['staff', 'manager'];

/**
 * THE DESK. Endpoints that describe a person standing in the salon, or the
 * salon's own diary, rather than a customer's own booking.
 *
 * The walk-in queue is the clearest case: a walk-in is somebody at the desk
 * being written down by whoever is behind it. Joining one remotely is not a
 * walk-in, it is a booking, and the booking endpoints already exist for that.
 * The same is true of diary compaction and the roster worklist, which move
 * OTHER customers' appointments around.
 *
 * `system` is included because the sweepers and relays act as the salon too:
 * a scheduled materialise or an auto-no-show is the salon acting on its own
 * diary, and excluding it would break the very jobs that keep the queue
 * honest. It cannot arrive over HTTP -- no issuer mints a system token -- so
 * including it widens nothing a caller can reach.
 */
export function mayWorkTheDesk(kind: ActorKind): boolean {
  return kind !== 'customer';
}

/**
 * Why they were refused, in words the client can show.
 *
 * Names the actor and the act, exactly as `checkTransition` does, because a
 * bare "Forbidden" sends the reader to the source to find out what happened.
 */
export function deskRefusal(kind: ActorKind): string {
  return `A ${kind} may not work the salon desk.`;
}
