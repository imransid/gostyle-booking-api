import { Money } from '../shared/money';
import { storedTotalFils, type StoredBreakdown } from '../booking/stored-money';
import { Account, type AccountKey } from './accounts';

/**
 * One deposit_ledger row, as the general ledger should see it.
 *
 * deposit_ledger is a customer-deposits subledger: append-only, signed, with
 * SUM(amount_fils) being what the salon holds against a booking. The GL
 * mirrors it ROW FOR ROW -- each row is exactly one journal entry -- which is
 * what makes the Deposits balance reconcilable against the subledger at all.
 *
 * ACCOUNTING POLICY, and it will change. It lives here, pure and tested, so
 * changing it is one edit with a spec beside it (CLAUDE.md 1).
 *
 * ---------------------------------------------------------------------
 * THE SIDE COMES FROM THE ENTRY TYPE, NEVER FROM THE SIGN
 *
 * The amount on the wire is always positive (the platform refuses anything
 * else) and the type says which way it moved. A sign as a second opinion is
 * how two lines end up cancelling into a "balanced" entry that moves both
 * accounts the wrong way.
 *
 * ---------------------------------------------------------------------
 * VAT: EVERY DEPOSITS LEG IS NET OF THE BOOKING'S VAT SHARE
 *
 * In the UAE receiving payment is a tax point, so the VAT in money taken
 * against a booking is owed the day it arrives. When the booking carries a
 * tax figure, the money is split once, by largest remainder (Money.allocate,
 * so the parts sum back to the whole), into the net share and the VAT share.
 *
 * VAT MOVES WITH MONEY crossing the boundary -- captured in, refunded out,
 * goodwill credited by the salon. It STAYS PUT when Deposits turns into
 * income -- a forfeit or a course draw moves only the net share, because the
 * VAT on that money was declared when it was received.
 */

export type LedgerEntryType =
  | 'captured'
  | 'applied_at_pos'
  | 'refunded'
  | 'partially_refunded'
  | 'forfeited'
  | 'reversed'
  | 'goodwill'
  | 'course_draw';

export type LedgerRail =
  | 'wallet'
  | 'card'
  | 'apple_pay'
  | 'cash'
  | 'link'
  | 'internal'
  | 'google_pay'
  | 'other';

export type LedgerActorKind = 'customer' | 'staff' | 'manager' | 'system';

export interface LedgerRowFacts {
  readonly ledgerId: string;
  readonly entryType: LedgerEntryType;
  /** Signed, as stored. Only `reversed` may be either sign. */
  readonly amountFils: number;
  readonly rail: LedgerRail | null;
  readonly actorKind: LedgerActorKind;
  readonly actorId: string | null;
  /** The branch-local date of the row, YYYY-MM-DD. Not the UTC date. */
  readonly entryDate: string;
  readonly tenantId: string;
  readonly bookingId: string;
  readonly bookingCode: string;
  readonly branchId: string;
  /** The booking's stored net / tax / discount, for the VAT share. */
  readonly breakdown: StoredBreakdown;
}

// ----------------------------------------------------------------- the wire

/**
 * CreateJournalEntryRequest, spelled as journal.proto spells it.
 *
 * snake_case on purpose: this is stored as the frozen request and sent
 * exactly as stored, so a camelCase copy would be a second representation
 * to keep in step. Unset proto fields (account_id, account_code,
 * supplier_id) are left out and arrive as ''.
 */
export type JournalSide = 'DEBIT' | 'CREDIT';

export interface JournalLineRequest {
  readonly system_key: AccountKey;
  readonly side: JournalSide;
  readonly amount_minor: number;
  readonly memo: string;
  readonly branch_id: string;
  /**
   * Always ''. Booking customer ids come from the consumer token and are not
   * platform customer ids; one the platform cannot resolve stays unresolved
   * forever, and the report's Name column is blank either way.
   */
  readonly customer_id: string;
}

export interface JournalEntryRequest {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly entry_date: string;
  readonly source_id: string;
  readonly memo: string;
  readonly lines: readonly JournalLineRequest[];
  readonly posted_by_id: string;
}

export type JournalPlanParkCode = 'NO_MAPPING' | 'TENANT_NOT_UUID';

export type JournalPlan =
  | { readonly kind: 'post'; readonly request: JournalEntryRequest }
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'park';
      readonly code: JournalPlanParkCode;
      readonly reason: string;
    };

// ------------------------------------------------------------------ the key

/**
 * The idempotency key: what the posting IS, never when it was sent.
 *
 * A ledger row is never edited, so the same key always means the same
 * posting. A correction (void, then repost) needs a NEW key -- a voided
 * entry's key stays used up -- hence the revision.
 */
export function journalKey(ledgerId: string, revision = 1): string {
  return revision === 1
    ? `deposit-ledger:${ledgerId}`
    : `deposit-ledger:${ledgerId}:${revision}`;
}

// ---------------------------------------------------------------- VAT share

/**
 * Split `amountFils` (positive) into its net and VAT shares, in the
 * proportion the booking's own breakdown carries. No tax figure, or a
 * breakdown that makes no sense (tax at or above the total), is no VAT.
 */
export function vatShare(
  amountFils: number,
  breakdown: StoredBreakdown,
): { readonly net: number; readonly vat: number } {
  const total = storedTotalFils(breakdown);
  const tax = breakdown.taxFils ?? 0;
  if (total === null || tax <= 0 || total <= tax) {
    return { net: amountFils, vat: 0 };
  }
  const [net, vat] = Money.fils(amountFils).allocate([total - tax, tax]);
  return { net: net?.fils ?? amountFils, vat: vat?.fils ?? 0 };
}

// --------------------------------------------------------------- the money

/**
 * Where the money itself sits, by rail.
 *
 * `internal` means no outside money moved. On a refund it is the wallet --
 * the cancellation and settlement paths both say so. On a capture nobody
 * said where it came from, so it is a clearing balance to reclassify.
 */
function moneyAccount(
  entryType: LedgerEntryType,
  rail: LedgerRail | null,
): AccountKey | null {
  switch (rail) {
    case 'card':
    case 'apple_pay':
    case 'google_pay':
    case 'link':
      // Taken by the gateway, not yet paid out to the bank.
      return Account.UNDEPOSITED_FUNDS;
    case 'wallet':
      return Account.CUSTOMER_WALLET;
    case 'cash':
      // NOT CASH_ON_HAND: that is the till, and desk cash that never went
      // through the POS would throw off every drawer count.
      return Account.FRONT_DESK_CASH;
    case 'other':
      return Account.PAYMENTS_CLEARING;
    case 'internal':
      return entryType === 'refunded'
        ? Account.CUSTOMER_WALLET
        : Account.PAYMENTS_CLEARING;
    case null:
      return null;
  }
}

const RAIL_LABEL: Readonly<Record<LedgerRail, string>> = {
  card: 'card',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  link: 'payment link',
  wallet: 'wallet',
  cash: 'cash',
  internal: 'internal',
  other: 'other',
};

// ---------------------------------------------------------------- the plan

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Leg = readonly [JournalSide, AccountKey, number, string?];

/**
 * The journal entry one deposit_ledger row becomes, or why it becomes none.
 *
 *   post  -- the frozen request, built once and sent unchanged on every try
 *   skip  -- booking-api never posts this (applied_at_pos: the till owns it)
 *   park  -- nobody has decided where it goes; a person has to
 */
export function planJournalEntry(row: LedgerRowFacts): JournalPlan {
  if (row.entryType === 'applied_at_pos') {
    // At checkout the deposit is consumed as tender on the POS ticket, and
    // the POS posts the ticket. Exactly one side may post the draw-down, and
    // it is the till's deposit tender -- posting it here as well would put
    // the service income in the books twice.
    return {
      kind: 'skip',
      reason: 'applied_at_pos is posted by the POS deposit tender',
    };
  }

  if (!UUID_RE.test(row.tenantId)) {
    return {
      kind: 'park',
      code: 'TENANT_NOT_UUID',
      reason: `booking tenant_id "${row.tenantId}" is not a UUID`,
    };
  }

  const amount = Math.abs(row.amountFils);
  if (amount === 0) {
    // deposit_ledger_never_zero forbids it; said here so the plan is total.
    return { kind: 'skip', reason: 'a zero row moves nothing' };
  }

  const legs = legsFor(row, amount);
  if (legs === null) {
    return {
      kind: 'park',
      code: 'NO_MAPPING',
      reason:
        `no account mapping for ${row.entryType}` +
        (row.rail === null ? ' with no rail' : ` on rail ${row.rail}`) +
        (row.amountFils < 0 ? ' (negative)' : ''),
    };
  }

  return {
    kind: 'post',
    request: {
      tenant_id: row.tenantId,
      idempotency_key: journalKey(row.ledgerId),
      entry_date: row.entryDate,
      source_id: row.bookingId,
      memo: memoFor(row),
      // A VAT share that rounds to nothing is no line: the platform refuses
      // an amount of 0, and an empty leg says nothing anyway.
      lines: legs
        .filter(([, , minor]) => minor > 0)
        .map(([side, key, minor, memo]) => ({
          system_key: key,
          side,
          amount_minor: minor,
          memo: memo ?? '',
          branch_id: row.branchId,
          customer_id: '',
        })),
      posted_by_id:
        (row.actorKind === 'staff' || row.actorKind === 'manager') &&
        row.actorId !== null
          ? row.actorId
          : '',
    },
  };
}

function legsFor(row: LedgerRowFacts, amount: number): Leg[] | null {
  const { net, vat } = vatShare(amount, row.breakdown);
  const DEPOSITS = Account.CUSTOMER_DEPOSITS;
  const VAT = Account.SALES_TAX_PAYABLE;

  switch (row.entryType) {
    case 'captured': {
      const money = moneyAccount(row.entryType, row.rail);
      if (money === null) return null;
      return [
        ['DEBIT', money, amount],
        ['CREDIT', DEPOSITS, net],
        ['CREDIT', VAT, vat, 'VAT'],
      ];
    }
    case 'refunded': {
      const money = moneyAccount(row.entryType, row.rail);
      if (money === null) return null;
      return [
        ['DEBIT', DEPOSITS, net],
        ['DEBIT', VAT, vat, 'VAT'],
        ['CREDIT', money, amount],
      ];
    }
    case 'goodwill':
      // Money the salon gives up. An expense, not a contra-income: there was
      // no sale for it to reverse.
      return [
        ['DEBIT', Account.CUSTOMER_GOODWILL, amount],
        ['CREDIT', DEPOSITS, net],
        ['CREDIT', VAT, vat, 'VAT'],
      ];
    case 'forfeited':
      return [
        ['DEBIT', DEPOSITS, net],
        ['CREDIT', Account.CANCELLATION_FEE_INCOME, net],
      ];
    case 'reversed':
      // A revived no-show: the forfeit, undone. Only ever written positive;
      // a negative reversal undoes something nobody has mapped.
      if (row.amountFils < 0) return null;
      return [
        ['DEBIT', Account.CANCELLATION_FEE_INCOME, net],
        ['CREDIT', DEPOSITS, net],
      ];
    case 'course_draw':
      return [
        ['DEBIT', DEPOSITS, net],
        ['CREDIT', Account.SERVICE_INCOME, net],
      ];
    case 'partially_refunded':
      // In the enum, written by nothing: partial refunds are `refunded` rows.
      return null;
    case 'applied_at_pos':
      return null;
  }
}

function memoFor(row: LedgerRowFacts): string {
  const rail = row.rail === null ? '' : ` (${RAIL_LABEL[row.rail]})`;
  const booking = `booking ${row.bookingCode}`;
  switch (row.entryType) {
    case 'captured':
      return `Deposit captured${rail}, ${booking}`;
    case 'refunded':
      return `Deposit refunded${rail}, ${booking}`;
    case 'forfeited':
      return `Deposit forfeited, ${booking}`;
    case 'reversed':
      return `Forfeit reversed, ${booking}`;
    case 'goodwill':
      return `Goodwill credit, ${booking}`;
    case 'course_draw':
      return `Course visit drawn, ${booking}`;
    case 'applied_at_pos':
      return `Deposit applied at the till, ${booking}`;
    case 'partially_refunded':
      return `Deposit partially refunded${rail}, ${booking}`;
  }
}
