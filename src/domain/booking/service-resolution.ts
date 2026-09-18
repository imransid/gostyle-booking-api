/**
 * Where a service came from, what it costs, and in which currency.
 *
 * Stage 1 of the slug-to-UUID migration has the engine resolving services
 * from TWO catalogues at once: platform over gRPC for real ids, and the
 * fixture for the slugs every existing caller still sends. That is a
 * temporary state by design, and the rules that make it safe live here
 * rather than inside the adapter, because they are the parts that can be
 * WRONG about money.
 */

import { Money } from '../shared/money';

// ------------------------------------------------------------ which source

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ServiceSource = 'platform' | 'fixture';

/**
 * A real platform id, or one of our slugs?
 *
 * This is the whole routing rule for stage 1, and it is deliberately dumb: a
 * uuid goes to platform, anything else goes to the fixture. It cannot be
 * cleverer, because the fixture's ids are hand-written words and platform's
 * are uuids, and there is no third case until stage 4 deletes the fixture.
 */
export function looksLikePlatformId(id: string): boolean {
  return UUID_RE.test(id);
}

// ------------------------------------------------------------ the money

/**
 * What one service costs, preferring what the catalogue said.
 *
 * WHY THIS EXISTS. `priceOf()` is a hard-coded slug→fils map that returns
 * **zero** for an id it does not know. A platform service resolved over gRPC
 * is exactly such an id, so it would have priced at AED 0.00 — silently, all
 * the way through the quote, the deposit ladder and the booking row. That is
 * the bug this migration is being done early to fix.
 *
 * A service that carries its own price uses it. One that does not falls back
 * to the caller's lookup, which is still the fixture map for slugs.
 */
export function priceOfService(
  /**
   * Narrower than `Service` on purpose: this reads exactly two fields, and
   * callers that hold only a partial row (the series materialiser does)
   * should not have to fabricate the rest to ask a price.
   */
  service: { readonly id: string; readonly priceFils?: number },
  fallback: (serviceId: string) => number,
): number {
  return service.priceFils ?? fallback(service.id);
}

// ------------------------------------------------------------ currency

/** What we quote in when nothing says otherwise. */
export const HOUSE_CURRENCY = 'AED';

export type CurrencyVerdict =
  | { readonly kind: 'ok'; readonly currency: string }
  | { readonly kind: 'mixed'; readonly currencies: readonly string[] };

/**
 * Every service in a basket must be priced in ONE currency.
 *
 * THIS IS NOT THEORETICAL. Production has services at the SAME branch in
 * different currencies — Keratin in BDT, NO Kampos in AED. `price_fils` is a
 * single integer with no currency beside it, so a basket containing both
 * would be summed as though the numbers were comparable. The customer would
 * be quoted a total that means nothing, and charged it.
 *
 * Refused, never converted. We have no rate, no source for one, and no
 * mandate to pick a moment to apply it. Adding two numbers of different
 * currencies is the one arithmetic error a money system must never make
 * quietly, so the basket is rejected and the desk is told which currencies
 * collided.
 *
 * A service with no currency is treated as the house currency: the fixture
 * carries no currency field and everything in it is AED.
 */
export function oneCurrency(
  services: readonly { readonly currency?: string | undefined }[],
): CurrencyVerdict {
  const seen = [
    ...new Set(
      services.map((s) => (s.currency ?? HOUSE_CURRENCY).toUpperCase()),
    ),
  ];

  if (seen.length <= 1) {
    return { kind: 'ok', currency: seen[0] ?? HOUSE_CURRENCY };
  }
  return { kind: 'mixed', currencies: seen.sort() };
}

/**
 * The sum, once the currency is known to be single.
 *
 * Takes the verdict rather than the services so it CANNOT be called on a
 * mixed basket: there is no argument you can pass that skips the check.
 */
export function totalOf(
  verdict: CurrencyVerdict,
  amounts: readonly number[],
): Money {
  if (verdict.kind === 'mixed') {
    throw new Error(
      `Refusing to total a basket in ${verdict.currencies.join(' and ')}`,
    );
  }
  return Money.sum(amounts.map((a) => Money.fils(a)));
}
