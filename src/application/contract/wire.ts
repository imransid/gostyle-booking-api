/**
 * The wire vocabulary: what the front end is promised, in one place.
 *
 * The engine speaks its own language and always has. Money is whole fils in
 * a `Money`, statuses are the lowercase snake_case labels Postgres stores,
 * and a party either arrives together or finishes together. None of that
 * changes here. What changes is the DIALECT SPOKEN AT THE EDGE:
 *
 *   priceFils          -> priceMinor         (the same integer, renamed)
 *   'pending_payment'  -> 'PENDING_PAYMENT'  (the same word, shouted)
 *   'arrive_together'  -> 'TOGETHER'         (a genuinely different name)
 *   'organiser_pays_all' -> 'ORGANIZER'      (ditto, and American)
 *
 * ONE translation, here, because a second one in a controller would drift and
 * the first anyone would hear of it is a front end rendering "UNDEFINED" in a
 * status pill.
 *
 * WHY NOT RENAME THE COLUMNS. `price_fils` says what the integer is: whole
 * fils, never a float, never a decimal (CLAUDE.md 2). `price_minor` says only
 * that it is smaller than something. The database keeps the precise name; the
 * contract gets the portable one. A minor unit IS a fil in AED, so the two
 * are the same number and no arithmetic happens at this boundary — which is
 * exactly why the translation is safe to do with a rename.
 */

// ------------------------------------------------------------ money

/**
 * Fils per dirham, and minor units per major unit. The same 100, named twice
 * because the front end asks the second question.
 *
 * Nothing in this module multiplies by it. It is here so that the day a
 * currency with a different exponent arrives, the search finds this file.
 */
export const MINOR_UNITS_PER_MAJOR = 100;

// ------------------------------------------------------------ statuses

/**
 * Statuses are the same words, shouted.
 *
 * A hand-written table of fourteen booking statuses is fourteen chances to
 * typo one, and the typo is invisible until a booking reaches that state in
 * production. `toUpperCase` cannot mistype. The template-literal type carries
 * the shape into the type system, so a controller that returns the wrong
 * union still fails `tsc`, and `wire.spec.ts` walks every member of every
 * union to prove the round trip.
 */
export type Shouted<T extends string> = Uppercase<T>;

export function shout<T extends string>(value: T): Shouted<T> {
  return value.toUpperCase() as Shouted<T>;
}

/**
 * Back down again, for the few statuses that arrive in a request.
 *
 * The allowed list is REQUIRED. Lowercasing an arbitrary string would happily
 * turn "DROP TABLE" into a status the compiler believes in; passing the union
 * means an unknown value is caught here rather than at the INSERT.
 */
export function unshout<T extends string>(
  value: string,
  allowed: readonly T[],
): T | null {
  const lowered = value.toLowerCase();
  return allowed.find((a) => a === lowered) ?? null;
}

// ------------------------------------------------------------ group mode

/**
 * The two names that are not a case change.
 *
 * `arrive_together` and `finish_together` describe the constraint; TOGETHER
 * and FINISH are what the wizard's two radio buttons are called. Both
 * directions are written out because neither can be derived from the other.
 */
export type DomainGroupMode = 'arrive_together' | 'finish_together';
export type WireGroupMode = 'TOGETHER' | 'FINISH';

const MODE_TO_WIRE: Readonly<Record<DomainGroupMode, WireGroupMode>> = {
  arrive_together: 'TOGETHER',
  finish_together: 'FINISH',
};

const MODE_FROM_WIRE: Readonly<Record<WireGroupMode, DomainGroupMode>> = {
  TOGETHER: 'arrive_together',
  FINISH: 'finish_together',
};

export const WIRE_GROUP_MODES = Object.keys(MODE_FROM_WIRE) as WireGroupMode[];

export function modeToWire(mode: DomainGroupMode): WireGroupMode {
  return MODE_TO_WIRE[mode];
}

export function modeFromWire(mode: WireGroupMode): DomainGroupMode {
  return MODE_FROM_WIRE[mode];
}

// ------------------------------------------------------------ who pays

export type DomainArrangement =
  'organiser_pays_all' | 'split_equally' | 'each_pays_own';

export type WireArrangement = 'ORGANIZER' | 'SPLIT' | 'OWN';

const ARRANGEMENT_TO_WIRE: Readonly<
  Record<DomainArrangement, WireArrangement>
> = {
  organiser_pays_all: 'ORGANIZER',
  split_equally: 'SPLIT',
  each_pays_own: 'OWN',
};

const ARRANGEMENT_FROM_WIRE: Readonly<
  Record<WireArrangement, DomainArrangement>
> = {
  ORGANIZER: 'organiser_pays_all',
  SPLIT: 'split_equally',
  OWN: 'each_pays_own',
};

export const WIRE_ARRANGEMENTS = Object.keys(
  ARRANGEMENT_FROM_WIRE,
) as WireArrangement[];

export function arrangementToWire(a: DomainArrangement): WireArrangement {
  return ARRANGEMENT_TO_WIRE[a];
}

export function arrangementFromWire(a: WireArrangement): DomainArrangement {
  return ARRANGEMENT_FROM_WIRE[a];
}

// ------------------------------------------------------------ quote lines

/**
 * A quote line, in the contract's dialect.
 *
 * `QuoteLine` is a domain shape and carries `amountFils` like everything else
 * in the engine. It is also the one domain structure that goes out to the
 * client verbatim, so it gets a translation rather than an exception.
 */
export interface WireQuoteLine {
  readonly label: string;
  readonly amountMinor: number;
  readonly negative: boolean;
  readonly note?: string;
}

export function toWireQuoteLine(line: {
  readonly label: string;
  readonly amountFils: number;
  readonly negative: boolean;
  readonly note?: string;
}): WireQuoteLine {
  return {
    label: line.label,
    amountMinor: line.amountFils,
    negative: line.negative,
    ...(line.note !== undefined ? { note: line.note } : {}),
  };
}

// ------------------------------------------------------------ the commit gate

/**
 * The roster-change gate, shouted.
 *
 * `Gate` is derived in the domain and every field but one goes out unchanged.
 * The one is `status`, which the front end renders as a pill beside every
 * other status pill in the application, so it obeys the same rule.
 */
export interface WireGate {
  readonly status: 'BLOCKED' | 'CLEAR';
  readonly mayCommit: boolean;
  readonly total: number;
  readonly open: number;
  readonly autoRepaired: number;
  readonly awaitingCancellation: readonly string[];
  readonly explanation: string;
}

export function toWireGate(gate: {
  readonly status: 'blocked' | 'clear';
  readonly mayCommit: boolean;
  readonly total: number;
  readonly open: number;
  readonly autoRepaired: number;
  readonly awaitingCancellation: readonly string[];
  readonly explanation: string;
}): WireGate {
  return { ...gate, status: shout(gate.status) };
}

// ------------------------------------------------------------ walk-in options

/**
 * The walk-in queue's "nearest options", shouted.
 *
 * The domain discriminates on `kind: 'now' | 'from' | 'next_gap'` — three
 * lowercase words the front end would otherwise have to match on. Only the
 * discriminant moves; the payload is the same object, so this is a rename at
 * the edge exactly like the statuses above.
 */
export type WireNearestOptionKind = 'NOW' | 'FROM' | 'NEXT_GAP';

export function toWireNearestOption<
  T extends { readonly kind: 'now' | 'from' | 'next_gap' },
>(option: T): Omit<T, 'kind'> & { readonly kind: WireNearestOptionKind } {
  const { kind, ...rest } = option;
  return { ...rest, kind: shout(kind) };
}
