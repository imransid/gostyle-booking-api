import { Money } from '../shared/money';
import { tierDiscountPercent, type Tier } from './customer';

/**
 * The money a visit costs, at the two moments it is computed.
 *
 * The QUOTE runs while the wizard is open and predicts. The SETTLEMENT runs
 * at the register and finalises with what actually happened: retail sold, a
 * tip, a promo code, loyalty redeemed.
 *
 * They are deliberately the same shape, because a quote that disagrees with
 * the till is how a customer finds out at the worst possible moment.
 */

export const VAT_PERCENT = 5;

// ---------------------------------------------------------------- the quote

export interface QuoteInput {
  /** Services at their snapshot prices. Net, exclusive of VAT. */
  readonly serviceFils: number;
  /** Booking-time extras, priced and duration-extending. */
  readonly addOnFils: number;
  /** The sum of the package parts minus the package price. */
  readonly bundleDiscountFils: number;
  readonly tier: Tier;
  /**
   * From the precedence engine, computed on the PRE-DISCOUNT total.
   *
   * This is the line that catches people out. A Gold customer's deposit is
   * not reduced by their discount, and it is not raised by VAT either: the
   * deposit protects the slot, and the slot is worth what it is worth.
   */
  readonly requirementFils: number;
}

export interface QuoteLine {
  readonly label: string;
  readonly amountFils: number;
  /** A discount is shown as a negative, so the column adds up on screen. */
  readonly negative: boolean;
  readonly note?: string;
}

export interface Quote {
  readonly subtotalNetFils: number;
  readonly addOnFils: number;
  readonly bundleDiscountFils: number;
  readonly tierDiscountFils: number;
  readonly discountedSubtotalFils: number;
  readonly vatFils: number;
  /** Inclusive of VAT. What the visit costs if nothing changes. */
  readonly totalFils: number;
  readonly dueNowFils: number;
  /** What is left at the register: the total minus what was taken now. */
  readonly dueAtCheckoutFils: number;
  readonly lines: readonly QuoteLine[];
}

export function quote(input: QuoteInput): Quote {
  const services = Money.fils(input.serviceFils);
  const addOns = Money.fils(input.addOnFils);
  const bundle = Money.fils(input.bundleDiscountFils);

  // Add-ons are service extras, so they share the service's discount base.
  // Retail never does, but retail does not exist at quote time.
  const serviceSubtotal = services.plus(addOns);
  const tierDiscount = serviceSubtotal
    .minus(bundle)
    .percent(tierDiscountPercent(input.tier));

  const discounted = serviceSubtotal.minus(bundle).minus(tierDiscount);

  // VAT sits on the DISCOUNTED subtotal, after add-ons and both discounts.
  // Charging it on the gross would tax money nobody paid.
  const vat = discounted.percent(VAT_PERCENT);
  const total = discounted.plus(vat);

  const dueNow = Money.fils(input.requirementFils);
  const dueAtCheckout = Money.max(Money.ZERO, total.minus(dueNow));

  const lines: QuoteLine[] = [
    { label: 'Subtotal (net)', amountFils: services.fils, negative: false },
  ];
  if (!addOns.isZero()) {
    lines.push({ label: 'Add-ons', amountFils: addOns.fils, negative: false });
  }
  if (!bundle.isZero()) {
    lines.push({
      label: 'Bundle discount',
      amountFils: bundle.fils,
      negative: true,
    });
  }
  if (!tierDiscount.isZero()) {
    lines.push({
      label: 'Tier discount',
      amountFils: tierDiscount.fils,
      negative: true,
      note: `${tierDiscountPercent(input.tier)}% off services`,
    });
  }
  lines.push({
    label: `VAT ${VAT_PERCENT}%`,
    amountFils: vat.fils,
    negative: false,
  });
  lines.push({ label: 'Total', amountFils: total.fils, negative: false });
  lines.push({
    label: 'Due now',
    amountFils: dueNow.fils,
    negative: false,
    note: 'on pre-discount total',
  });

  return {
    subtotalNetFils: services.fils,
    addOnFils: addOns.fils,
    bundleDiscountFils: bundle.fils,
    tierDiscountFils: tierDiscount.fils,
    discountedSubtotalFils: discounted.fils,
    vatFils: vat.fils,
    totalFils: total.fils,
    dueNowFils: dueNow.fils,
    dueAtCheckoutFils: dueAtCheckout.fils,
    lines,
  };
}

// ---------------------------------------------------------------- settlement

export const PROMO_PERCENT = 10;

export interface SettlementInput {
  readonly serviceFils: number;
  readonly addOnFils: number;
  /** Products sold at the till. Never discounted by tier, never tipped on. */
  readonly retailFils: number;
  readonly tier: Tier;
  readonly promoApplies: boolean;
  /** A percentage of the tippable base, or a custom amount. Not both. */
  readonly tipPercent?: number;
  readonly tipFils?: number;
  /** What was captured at booking. Tender, not a discount. */
  readonly depositAppliedFils: number;
  readonly loyaltyRedeemFils: number;
  /** A manager may zero the VAT, and must say why. */
  readonly taxExemptReason?: string;
}

export interface Settlement {
  readonly subtotalFils: number;
  readonly tierDiscountFils: number;
  readonly promoFils: number;
  readonly baseFils: number;
  readonly tipFils: number;
  readonly vatFils: number;
  readonly depositAppliedFils: number;
  readonly loyaltyRedeemFils: number;
  /** Never negative. An overpayment becomes credit instead. */
  readonly dueFils: number;
  /** Credited to the wallet at close, or refunded to source on request. */
  readonly creditFils: number;
  readonly taxExempt: boolean;
}

/**
 * The arithmetic at the register.
 *
 *   subtotal        = services + add-ons + retail
 *   tier discount   = 10% of the SERVICE subtotal for a Gold customer
 *   promo           = 10% of (service subtotal - tier discount)
 *   base            = subtotal - tier discount - promo
 *   tip             = percentage of (base - retail), or a custom amount
 *   VAT             = 5% of base, or 0 under a manager's exemption
 *   due             = base + tip + VAT - deposit applied - loyalty redeem
 *   credit          = -due when that is negative; due floors at zero
 *
 * Three rules the shape encodes:
 *
 *   DEPOSITS ARE TENDER, NOT DISCOUNTS. The captured amount is subtracted at
 *   the end, after VAT, as a payment line. Subtracting it earlier would
 *   quietly reduce the tax due, which is a different thing entirely.
 *
 *   TIPS ARE CHARGED FRESH, and never on retail. A tip is not drawn from a
 *   deposit, and nobody tips on a bottle of shampoo.
 *
 *   OVERPAYMENT IS CREDITED, NOT KEPT. A bill below the prepaid amount leaves
 *   the customer in credit, shown as its own line on the receipt.
 */
export function settle(input: SettlementInput): Settlement {
  const services = Money.fils(input.serviceFils);
  const addOns = Money.fils(input.addOnFils);
  const retail = Money.fils(input.retailFils);

  const serviceSubtotal = services.plus(addOns);
  const subtotal = serviceSubtotal.plus(retail);

  // On services, never on retail.
  const tierDiscount = serviceSubtotal.percent(tierDiscountPercent(input.tier));

  const promo = input.promoApplies
    ? serviceSubtotal.minus(tierDiscount).percent(PROMO_PERCENT)
    : Money.ZERO;

  const base = subtotal.minus(tierDiscount).minus(promo);

  // Nobody tips on retail.
  const tippable = base.minus(retail);
  const tip =
    input.tipFils !== undefined
      ? Money.fils(input.tipFils)
      : input.tipPercent !== undefined
        ? tippable.percent(input.tipPercent)
        : Money.ZERO;

  const taxExempt = input.taxExemptReason !== undefined;
  const vat = taxExempt ? Money.ZERO : base.percent(VAT_PERCENT);

  const deposit = Money.fils(input.depositAppliedFils);
  const loyalty = Money.fils(input.loyaltyRedeemFils);

  const raw = base.plus(tip).plus(vat).minus(deposit).minus(loyalty);

  return {
    subtotalFils: subtotal.fils,
    tierDiscountFils: tierDiscount.fils,
    promoFils: promo.fils,
    baseFils: base.fils,
    tipFils: tip.fils,
    vatFils: vat.fils,
    depositAppliedFils: deposit.fils,
    loyaltyRedeemFils: loyalty.fils,
    dueFils: raw.isNegative() ? 0 : raw.fils,
    creditFils: raw.isNegative() ? raw.negate().fils : 0,
    taxExempt,
  };
}
