/**
 * Money in AED, stored as whole fils (1 AED = 100 fils).
 *
 * Rule: integers all the way through, decimal only at the last inch (toDisplay).
 * A fractional fil is a bug, so the constructor refuses one outright.
 */
export class Money {
  private constructor(public readonly fils: number) {
    if (!Number.isInteger(fils)) {
      throw new Error(`Money must be whole fils, got ${fils}`);
    }
  }

  static readonly ZERO = new Money(0);

  /** From minor units, e.g. straight out of the database. */
  static fils(f: number): Money {
    return new Money(f);
  }

  /** From major units, e.g. a price list or config. */
  static aed(dirhams: number): Money {
    return new Money(Math.round(dirhams * 100));
  }

  // ---------------------------------------------------------------- arithmetic

  plus(other: Money): Money {
    return new Money(this.fils + other.fils);
  }

  minus(other: Money): Money {
    return new Money(this.fils - other.fils);
  }

  /** Rounds once, here. Never leave a fraction to be added up later. */
  percent(p: number): Money {
    return new Money(Math.round((this.fils * p) / 100));
  }

  negate(): Money {
    return new Money(-this.fils);
  }

  abs(): Money {
    return new Money(Math.abs(this.fils));
  }

  // ---------------------------------------------------------------- comparison

  isZero(): boolean {
    return this.fils === 0;
  }

  isNegative(): boolean {
    return this.fils < 0;
  }

  equals(other: Money): boolean {
    return this.fils === other.fils;
  }

  lessThan(other: Money): boolean {
    return this.fils < other.fils;
  }

  greaterThan(other: Money): boolean {
    return this.fils > other.fils;
  }

  /** Branch floor and ceiling, per the deposit clamp rule. */
  clamp(floor: Money, ceiling: Money): Money {
    if (this.lessThan(floor)) return floor;
    if (this.greaterThan(ceiling)) return ceiling;
    return this;
  }

  /** "Between two deposits the larger amount wins." */
  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }

  // ---------------------------------------------------------------- allocation

  /**
   * Split across weights, largest-remainder. The parts ALWAYS sum back to the
   * whole, which is what keeps the "tenders equal totals" invariant true.
   *
   * Used for: tip distribution by service value, bundle discount across parts.
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new Error('allocate needs at least one weight');
    }
    if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
      throw new Error('weights must be finite and non-negative');
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
      throw new Error('weights must sum to more than zero');
    }

    // Work on the magnitude, re-apply the sign at the end, so a negative
    // total (a discount being spread) allocates the same way as a positive one.
    const sign = this.fils < 0 ? -1 : 1;
    const magnitude = Math.abs(this.fils);

    const exact = weights.map((w) => (magnitude * w) / totalWeight);
    const parts = exact.map((e) => Math.floor(e));

    let remainder = magnitude - parts.reduce((a, b) => a + b, 0);

    // Hand the leftover fils to the largest fractional parts first.
    // Ties break by index, so the result is deterministic.
    const order = exact
      .map((e, i) => ({ i, frac: e - Math.floor(e) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);

    let k = 0;
    while (remainder > 0) {
      const slot = order[k % order.length];
      if (slot === undefined) break;
      parts[slot.i] = (parts[slot.i] ?? 0) + 1;
      remainder -= 1;
      k += 1;
    }

    return parts.map((f) => new Money(sign * f));
  }

  /** Equal split, e.g. a group deposit shared by participant count. */
  split(n: number): Money[] {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Cannot split into ${n} parts`);
    }
    return this.allocate(new Array<number>(n).fill(1));
  }

  static sum(parts: readonly Money[]): Money {
    return parts.reduce<Money>((acc, m) => acc.plus(m), Money.ZERO);
  }

  // ---------------------------------------------------------------- edge only

  toDisplay(): string {
    return (this.fils / 100).toFixed(2);
  }

  toString(): string {
    return `AED ${this.toDisplay()}`;
  }
}
