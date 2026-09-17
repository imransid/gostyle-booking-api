import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { ActorKind } from '@domain/booking/lifecycle';
import type {
  LedgerEntryType,
  PaymentRail,
} from '../../generated/prisma/enums';

/**
 * The money-moving desk actions: capture, refund, goodwill, revive.
 *
 * WHY A REPOSITORY OF ITS OWN. Each of these is a small transaction that
 * writes exactly one ledger row and, sometimes, moves the booking's status.
 * LifecycleRepository owns the state machine and settlement; these are not
 * transitions in that machine -- taking the link amount at the desk does not
 * change what a booking IS, it changes what has been paid.
 *
 * THE LEDGER IS APPEND-ONLY, ENFORCED BY A DATABASE TRIGGER. Nothing here
 * updates or deletes an entry, and it could not if it tried. A refund writes
 * a NEW negative row; it never reverses the old one. That is what makes the
 * protected balance `SUM(amount_fils)` rather than a story someone has to
 * reconstruct.
 *
 * EVERY METHOD IS IDEMPOTENT BY A KEY. These endpoints take money, and a
 * retried request that charged twice would be the worst bug this service
 * could have. The key is stored on the ledger row's reason as a marker and
 * checked before the write, inside the same transaction.
 */

export interface MoneyActionInput {
  readonly bookingId: string;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly reason: string;
  /** Idempotency-Key. A repeat returns the original entry, unchanged. */
  readonly idempotencyKey: string;
}

export type MoneyOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  | {
      readonly kind: 'done';
      readonly entryId: string | null;
      readonly amountFils: number;
      readonly balanceFils: number;
      readonly replayed: boolean;
      readonly code: string;
      readonly status: string;
      readonly paymentStatus: string;
    };

/** Prefix that makes an idempotency marker findable in the reason text. */
const KEY = '#idem:';

@Injectable()
export class MoneyRepository {
  private static readonly log = new Logger(MoneyRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * §7.6 "Take at desk".
   *
   * The customer pays the pending link's amount in person. The LINK MUST DIE:
   * leaving it live means the same deposit can be paid twice, once at the
   * desk and once on a phone in the car park, and the second one arrives as
   * a webhook against a booking that is already confirmed.
   */
  capture(
    input: MoneyActionInput & { readonly rail: PaymentRail },
  ): Promise<MoneyOutcome> {
    return this.act(input, (b) => {
      if (b.status !== 'pending_payment') {
        return {
          error: `Only a booking awaiting payment can be captured at the desk; this one is ${b.status}.`,
        };
      }
      const owed = b.deposit_fils > 0 ? b.deposit_fils : b.price_fils;
      return {
        entryType: 'captured',
        amountFils: owed,
        rail: input.rail,
        status: 'confirmed',
        paymentStatus: owed >= b.price_fils ? 'fully_paid' : 'deposit_paid',
        // The link is invalidated in the same transaction as the capture.
        clearLink: true,
      };
    });
  }

  /**
   * §7.9 Refund, manager-only, settled bookings only.
   *
   * A LINKED REVERSAL, not an edit. The original capture row stays exactly
   * where it is and a negative row is appended beside it, so the ticket still
   * shows what was taken and the register total is untouched.
   */
  refund(
    input: MoneyActionInput & {
      readonly mode: 'DEPOSIT' | 'FULL';
      readonly amountFils?: number | undefined;
      readonly rail: PaymentRail;
    },
  ): Promise<MoneyOutcome> {
    return this.act(input, (b, balance) => {
      if (b.status !== 'settled' && b.status !== 'completed') {
        return {
          error: `Only a settled booking can be refunded; this one is ${b.status}.`,
        };
      }
      const wanted =
        input.amountFils ??
        (input.mode === 'FULL' ? balance : Math.min(b.deposit_fils, balance));

      if (wanted <= 0) {
        return { error: 'There is nothing left on this booking to refund.' };
      }
      if (wanted > balance) {
        return {
          error: `Only ${balance} fils remain on this booking; ${wanted} was asked for.`,
        };
      }
      return {
        entryType: 'refunded',
        amountFils: -wanted,
        rail: input.rail,
        paymentStatus: wanted >= balance ? 'refunded' : 'partially_refunded',
      };
    });
  }

  /**
   * §7.10 Goodwill, manager-only.
   *
   * Credits a forfeited deposit toward a rebook WITHOUT reversing the
   * forfeit. Both sides stay on the ledger, and the risk score is untouched:
   * the customer still did not turn up, and a goodwill gesture is not a
   * finding that they did.
   */
  goodwill(
    input: MoneyActionInput & { readonly amountFils: number },
  ): Promise<MoneyOutcome> {
    return this.act(input, (b) => {
      if (input.amountFils <= 0) {
        return { error: 'A goodwill credit has to be a positive amount.' };
      }
      if (b.payment_status !== 'forfeited') {
        return {
          error: `Goodwill credits a forfeited deposit; this booking is ${b.payment_status}.`,
        };
      }
      return {
        entryType: 'goodwill',
        amountFils: input.amountFils,
        rail: 'internal',
        // Deliberately NOT changing payment_status: the forfeit stands.
      };
    });
  }

  /**
   * §7.8 Revive a no-show, manager-only.
   *
   * RE-OPENS THE ORIGINAL POSITION rather than writing a refund. The money
   * never left; it was forfeited against a visit that is now going to happen
   * after all. A refund plus a fresh capture would be two gateway round trips
   * and two rows to explain, to arrive where a single reversal already is.
   */
  revive(input: MoneyActionInput): Promise<MoneyOutcome> {
    return this.act(input, (b, _balance, forfeit) => {
      if (b.status !== 'no_show') {
        return {
          error: `Only a no-show can be revived; this one is ${b.status}.`,
        };
      }
      /**
       * GOODWILL AND REVIVE ARE ALTERNATIVES, not a sequence.
       *
       * Goodwill credits a forfeited deposit toward a future visit; revive
       * puts that same deposit back on THIS one. Doing both credits the
       * customer the deposit twice -- proven by doing exactly that against a
       * running server, which left GS-1010 carrying AED 80 against a AED 40
       * capture. The ledger was right about every individual row and the
       * total was nonsense, which is the failure mode a signed ledger is
       * supposed to make impossible.
       */
      if (forfeit.goodwillFils > 0) {
        return {
          error:
            'This forfeit has already been credited as goodwill. Apply that ' +
            'credit to the new booking rather than reviving this one, or the ' +
            'deposit is given back twice.',
        };
      }

      /**
       * REVERSE THE FORFEIT, which is what "re-open the original position"
       * means in ledger terms: the forfeit row took the deposit out of the
       * protected balance, and the visit is now going to happen, so it goes
       * back in. A refund would send the money to the customer, who is about
       * to spend it here.
       *
       * A no-show with nothing forfeited writes NO LEDGER ROW. The first
       * version wrote a zero-amount `reversed` entry and Postgres refused it
       * on `deposit_ledger_never_zero` -- correctly. A ledger line for no
       * money is a line that means nothing, and the constraint exists so
       * nobody can leave one behind.
       */
      return {
        entryType: 'reversed',
        amountFils: forfeit.fils,
        rail: 'internal',
        linkedEntryId: forfeit.entryId,
        status: 'confirmed',
        paymentStatus: forfeit.fils > 0 ? 'deposit_paid' : 'none_required',
      };
    });
  }

  // ------------------------------------------------------------ the engine

  /**
   * Load, decide, write, in one transaction.
   *
   * The decision function is pure and receives the booking plus its current
   * protected balance. It either refuses with a sentence or returns the row
   * to append; it never touches the database itself, so every one of these
   * actions gets the same locking, the same idempotency and the same audit
   * without any of them remembering to ask.
   */
  private async act(
    input: MoneyActionInput,
    decide: (
      b: {
        id: string;
        code: string;
        status: string;
        payment_status: string;
        price_fils: number;
        deposit_fils: number;
      },
      balanceFils: number,
      /** The forfeit being carried, and the row that created it. */
      forfeit: {
        fils: number;
        entryId: string | null;
        goodwillFils: number;
      },
    ) =>
      | { error: string }
      | {
          entryType: LedgerEntryType;
          amountFils: number;
          rail: PaymentRail;
          status?: string;
          paymentStatus?: string;
          clearLink?: boolean;
          /** Required for `reversed`; the DB refuses an unlinked one. */
          linkedEntryId?: string | null;
        },
  ): Promise<MoneyOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            code: string;
            status: string;
            payment_status: string;
            price_fils: number;
            deposit_fils: number;
          }[]
        >`
        SELECT id, code, status::text AS status,
               payment_status::text AS payment_status, price_fils, deposit_fils
          FROM booking
         WHERE id = ${input.bookingId}::uuid
         FOR UPDATE`;

        const b = rows[0];
        if (b === undefined) return { kind: 'not_found' as const };

        // A REPLAY IS ANSWERED BEFORE ANYTHING IS DECIDED. The second call with
        // the same key must not be refused for being illegal now -- capture
        // moves the booking out of pending_payment, so the retry would see a
        // confirmed booking and report a conflict for work it already did.
        const marker = `${KEY}${input.idempotencyKey}`;
        const prior = await tx.depositLedger.findFirst({
          where: { bookingId: b.id, reason: { contains: marker } },
        });
        if (prior !== null) {
          return {
            kind: 'done' as const,
            entryId: prior.id,
            amountFils: prior.amountFils,
            balanceFils: await balanceOf(tx, b.id),
            replayed: true,
            code: b.code,
            status: b.status,
            paymentStatus: b.payment_status,
          };
        }

        const balance = await balanceOf(tx, b.id);
        const forfeited = await forfeitedOf(tx, b.id);
        const decision = decide(b, balance, forfeited);
        if ('error' in decision) {
          return { kind: 'illegal' as const, message: decision.error };
        }

        /**
         * NO ROW FOR NO MONEY. `deposit_ledger_never_zero` refuses a
         * zero-amount entry, and it is right to: an action that moved nothing
         * has nothing to say on a money ledger. The status change and the
         * history row still happen, so the action is not lost -- it is
         * recorded where it belongs.
         */
        const entry =
          decision.amountFils === 0
            ? null
            : await tx.depositLedger.create({
                data: {
                  bookingId: b.id,
                  entryType: decision.entryType,
                  amountFils: decision.amountFils,
                  rail: decision.rail,
                  reason: `${input.reason} ${marker}`,
                  actorKind: input.actor,
                  actorId:
                    input.actor === 'system' || input.actorId === null
                      ? null
                      : toUuid(input.actorId),
                  ...(decision.linkedEntryId == null
                    ? {}
                    : { linkedEntryId: decision.linkedEntryId }),
                },
              });

        if (
          decision.status !== undefined ||
          decision.paymentStatus !== undefined
        ) {
          await tx.$executeRawUnsafe(
            `UPDATE booking
              SET status = COALESCE($2::booking_status, status),
                  payment_status = COALESCE($3::payment_status, payment_status),
                  link_expires_at = CASE WHEN $4 THEN NULL ELSE link_expires_at END,
                  updated_at = now()
            WHERE id = $1::uuid`,
            b.id,
            decision.status ?? null,
            decision.paymentStatus ?? null,
            decision.clearLink === true,
          );

          await tx.bookingStatusHistory.create({
            data: {
              bookingId: b.id,
              fromStatus: b.status as never,
              toStatus: (decision.status ?? b.status) as never,
              reason: input.reason,
              actorKind: input.actor,
              actorId:
                input.actor === 'system' || input.actorId === null
                  ? null
                  : toUuid(input.actorId),
            },
          });
        }

        MoneyRepository.log.log(
          `${b.code} ${decision.entryType} ${decision.amountFils} fils (${input.reason})`,
        );

        return {
          kind: 'done' as const,
          entryId: entry?.id ?? null,
          amountFils: decision.amountFils,
          balanceFils: balance + decision.amountFils,
          replayed: false,
          code: b.code,
          status: decision.status ?? b.status,
          paymentStatus: decision.paymentStatus ?? b.payment_status,
        };
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
  }
}

/**
 * The forfeit this booking is carrying, and the row that caused it.
 *
 * BOTH, because `deposit_ledger_reversal_linked` requires a `reversed` entry
 * to name what it reverses. That constraint is the reason the ledger can be
 * read as a story rather than a column of numbers: every correction points
 * at the thing it corrects, so nothing is a mystery adjustment.
 */
async function forfeitedOf(
  tx: {
    $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  },
  bookingId: string,
): Promise<{ fils: number; entryId: string | null; goodwillFils: number }> {
  const rows = await tx.$queryRaw<{ id: string; amount_fils: number }[]>`
    SELECT id, amount_fils
      FROM deposit_ledger
     WHERE booking_id = ${bookingId}::uuid AND entry_type = 'forfeited'
     ORDER BY created_at DESC
     LIMIT 1`;
  const goodwill = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_fils) AS total
      FROM deposit_ledger
     WHERE booking_id = ${bookingId}::uuid AND entry_type = 'goodwill'`;

  const row = rows[0];
  return {
    fils: row === undefined ? 0 : Math.max(0, -row.amount_fils),
    entryId: row?.id ?? null,
    goodwillFils: Number(goodwill[0]?.total ?? 0n),
  };
}

/** The protected balance: signed entries, summed. Never a stored column. */
async function balanceOf(
  tx: {
    $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  },
  bookingId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
    SELECT sum(amount_fils) AS balance
      FROM deposit_ledger WHERE booking_id = ${bookingId}::uuid`;
  return Number(rows[0]?.balance ?? 0n);
}
