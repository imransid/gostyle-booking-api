/**
 * One party, many start times, one picture of the day.
 *
 * The mobile day view asks "when today can this party be seated?", and the
 * engine answered one start at a time. Every one of those calls reloaded the
 * same day, the same roster and the same services to run a planner that
 * costs almost nothing by comparison, so a screen of twenty-four starts was
 * twenty-four loads.
 *
 * This is the planning half, and it is deliberately nothing more than
 * `planParty` per start. `planParty` is pure -- it reads the context and
 * never writes to it -- so asking it about every start against ONE context
 * gives each start exactly the answer it would have had alone, against that
 * same diary. No second planner, no shortcut that could disagree with the
 * single answer (CLAUDE.md 4).
 */

import { DAY_END_MIN, DAY_START_MIN } from './grid';
import {
  planParty,
  type GroupMode,
  type PartyContext,
  type PartyOptions,
  type PartyParticipant,
  type PartyPlan,
} from './party';

/**
 * The most start times one request may ask about.
 *
 * TWENTY-FOUR IS THE ENGINE'S WHOLE DAY AT HALF-HOUR STEPS: 10:00, 10:30, ...
 * 21:30. That is the day view the app draws, so one screen is one call.
 *
 * Not more, because the planner is cheap for an ordinary party and is NOT
 * cheap for every party. Measured on this machine: forty-eight starts for a
 * party of four cost about a millisecond in total, but a party of eight
 * needing more styling chairs than the branch has searches every way of
 * seating them before giving up -- about 40 ms a start with twenty hair
 * professionals, several hundred with thirty. That time is spent on the one
 * thread every other request shares. The cap is what bounds how long one
 * call can hold it; a denser grid is two calls, which is the caller saying
 * it wants the wait.
 */
export const MAX_PARTY_STARTS = 24;

/** The half-hour starts of the engine's day, which the cap is sized to. */
export function halfHourStarts(): number[] {
  const out: number[] = [];
  for (let m = DAY_START_MIN; m < DAY_END_MIN; m += 30) out.push(m);
  return out;
}

/**
 * Plan the party at each start, against the one context given.
 *
 * One answer per start, in the order asked -- a repeat is answered twice,
 * an unsorted list stays unsorted -- because the caller matches answers to
 * questions by position. The cap is the edge's to enforce, not this
 * function's: the rule here is only that each answer is `planParty`'s.
 */
export function planPartyAtEach(
  participants: readonly PartyParticipant[],
  starts: readonly number[],
  mode: GroupMode,
  ctx: PartyContext,
  options: PartyOptions = {},
): PartyPlan[] {
  return starts.map((startMin) =>
    planParty(participants, startMin, mode, ctx, options),
  );
}
