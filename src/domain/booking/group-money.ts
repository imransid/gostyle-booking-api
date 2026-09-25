import { Money } from '@domain/shared/money';
import { VAT_PERCENT } from './quote';
import { productMoney } from './mobile-products';

/**
 * What a mobile group booking costs, member by member and for the party.
 *
 * ONE PLACE FOR EVERY FIGURE (CLAUDE.md 1, 4). The create checks the app's
 * numbers against this, the confirm stores what this says, and the read adds
 * the stored lanes back up. If a price is ever worked out anywhere else for a
 * mobile party, that is the bug.
 *
 * The rules, from docs/APP_GROUP_BOOKING_SPEC.md §5 and the plan's decisions:
 *
 *   - A service costs the salon's own price. A member whose `age_group` is
 *     `child` pays CHILD_SERVICE_PERCENT of each service. Products are never
 *     discounted: the child rule is about the visit, not the shop.
 *   - No tier discount and no promo code for a party (D2): `discountFils` is
 *     always zero.
 *   - VAT is charged ONCE, on the party's whole taxable base, and then split
 *     to the members. Rounding per member and adding up could miss the
 *     party's VAT by a fil per member; rounding once cannot (CLAUDE.md 2).
 *   - The deposit is `depositPercent` of the party's total, rounded once,
 *     then split the same way.
 *
 * Every split uses Money.allocate, so the members always add back up to the
 * party exactly: no fil is lost or invented.
 */

/** What a child pays of each service's price. */
export const CHILD_SERVICE_PERCENT = 50;

export type AgeGroup = 'adult' | 'child';

export interface MemberBasket {
  readonly ageGroup: AgeGroup;
  /** Each service's LIST price, whole fils, in the order picked. */
  readonly serviceFils: readonly number[];
  /** Unit price and quantity of each product line, as sold. */
  readonly products: readonly {
    readonly priceFils: number;
    readonly quantity: number;
  }[];
}

export interface MemberMoney {
  /** Each service as charged: the child price already applied. */
  readonly serviceFils: readonly number[];
  readonly servicesNetFils: number;
  readonly productsNetFils: number;
  /** Services plus products, before VAT. */
  readonly netFils: number;
  /** This member's share of the party's VAT. */
  readonly vatFils: number;
  readonly totalFils: number;
  /** This member's share of the party's deposit. */
  readonly depositFils: number;
}

export interface GroupMoney {
  readonly members: readonly MemberMoney[];
  readonly netFils: number;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number;
  readonly depositPercent: number;
  readonly depositFils: number;
}

/** A service's price for one member. */
export function chargedServiceFils(
  listFils: number,
  ageGroup: AgeGroup,
): number {
  return ageGroup === 'child'
    ? Money.fils(listFils).percent(CHILD_SERVICE_PERCENT).fils
    : Money.fils(listFils).fils;
}

export function groupMoney(
  members: readonly MemberBasket[],
  depositPercent: number,
): GroupMoney {
  if (members.length === 0) throw new Error('a party needs members');
  if (
    !Number.isInteger(depositPercent) ||
    depositPercent < 0 ||
    depositPercent > 100
  ) {
    throw new Error(`depositPercent must be 0 to 100, got ${depositPercent}`);
  }

  const lines = members.map((m) => {
    const serviceFils = m.serviceFils.map((f) =>
      chargedServiceFils(f, m.ageGroup),
    );
    const servicesNetFils = Money.sum(
      serviceFils.map((f) => Money.fils(f)),
    ).fils;
    const productsNetFils = productMoney(m.products).netFils;
    return {
      serviceFils,
      servicesNetFils,
      productsNetFils,
      netFils: servicesNetFils + productsNetFils,
    };
  });

  const net = Money.sum(lines.map((l) => Money.fils(l.netFils)));
  const vat = net.percent(VAT_PERCENT);
  const total = net.plus(vat);
  const deposit = total.percent(depositPercent);

  const vatShares = spread(
    vat,
    lines.map((l) => l.netFils),
  );
  const totals = lines.map((l, i) => l.netFils + vatShares[i]!);
  const depositShares = spread(deposit, totals);

  return {
    members: lines.map((l, i) => ({
      ...l,
      vatFils: vatShares[i]!,
      totalFils: totals[i]!,
      depositFils: depositShares[i]!,
    })),
    netFils: net.fils,
    vatFils: vat.fils,
    discountFils: 0,
    totalFils: total.fils,
    depositPercent,
    depositFils: deposit.fils,
  };
}

/**
 * Split an amount by weights. A party that costs nothing has nothing to split,
 * and allocate refuses all-zero weights, so zero is answered directly.
 */
function spread(amount: Money, weights: readonly number[]): number[] {
  if (amount.isZero() || weights.every((w) => w === 0)) {
    return weights.map(() => 0);
  }
  return amount.allocate(weights).map((m) => m.fils);
}

/**
 * The VAT a member's row stores against its SERVICES.
 *
 * A booking row's net_fils and tax_fils are the services' alone, and the
 * products' figures are added on read from booking_product (the single
 * booking's rule, mobile-booking.handler `moneyFor`). A member's VAT share
 * covers both, so the services' part is the share minus what the products'
 * own VAT comes to. Stored that way, the row plus its products adds back up
 * to exactly the member's total, by the same arithmetic the single read uses.
 */
export function servicesVatFils(
  member: Pick<MemberMoney, 'vatFils'>,
  products: MemberBasket['products'],
): number {
  return member.vatFils - productMoney(products).vatFils;
}
