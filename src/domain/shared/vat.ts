import { Money } from './money';

/**
 * A tenant's VAT, as the till charges it (gostyle-platform
 * docs/booking-pos-tickets-plan.md, B9 / P13).
 *
 * The POS charges each tenant's own rate, and either adds it to catalogue
 * prices (EXCLUSIVE) or finds it inside them (INCLUSIVE). booking-api has
 * always added 5% on top (VAT_PERCENT), so an app quote and the till's bill
 * disagree for any tenant that is not 5% exclusive. This is the value that
 * lets them agree; DEFAULT_VAT is exactly today's behaviour.
 *
 * Rounds ONCE, here, like Money.percent (CLAUDE.md 2): half up on the
 * positive figure, which Math.round does.
 */
export interface VatPolicy {
  /** Basis points: 500 is 5%. */
  readonly bps: number;
  /** True: catalogue prices already include the VAT. */
  readonly inclusive: boolean;
}

/** 5%, added on top: every figure this service has ever quoted. */
export const DEFAULT_VAT: VatPolicy = { bps: 500, inclusive: false };

/**
 * The VAT on a NET amount (exclusive pricing).
 *
 * At 500 bps this is bit-identical to `net.percent(5)`: fils x 500 / 10000
 * and fils x 5 / 100 are the same rational, so the division produces the
 * same double and Math.round the same integer (vat.spec.ts proves it over a
 * range). Switching a caller from VAT_PERCENT to this changes no figure.
 */
export function vatOnNet(net: Money, policy: VatPolicy): Money {
  return Money.fils(Math.round((net.fils * policy.bps) / 10_000));
}

/**
 * The VAT INSIDE a gross amount (inclusive pricing): gross x bps / (10000 +
 * bps). The net is the gross minus this, so the two always add back.
 */
export function vatInsideGross(gross: Money, policy: VatPolicy): Money {
  return Money.fils(
    Math.round((gross.fils * policy.bps) / (10_000 + policy.bps)),
  );
}

/** "VAT 5%", "VAT 5.5%": the label a quote line carries. */
export function vatLabel(policy: VatPolicy): string {
  const percent = policy.bps / 100;
  return `VAT ${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

/** A rate the platform could send that this service will not charge. */
export function saneVatPolicy(p: VatPolicy): boolean {
  return Number.isInteger(p.bps) && p.bps >= 0 && p.bps <= 10_000;
}
