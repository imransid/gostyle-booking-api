import { describe, it, expect } from 'vitest';
import { Money } from './money';
import {
  DEFAULT_VAT,
  saneVatPolicy,
  vatInsideGross,
  vatLabel,
  vatOnNet,
} from './vat';
import { VAT_PERCENT } from '../booking/quote';

describe('vatOnNet', () => {
  it('is bit-identical to today’s percent(VAT_PERCENT) at the default', () => {
    // Every fil amount up to AED 2,000, and a sweep of large ones: the
    // golden test that switching a caller to the policy changes no figure.
    expect(VAT_PERCENT).toBe(5);
    for (let f = 0; f <= 200_000; f += 1) {
      const net = Money.fils(f);
      if (vatOnNet(net, DEFAULT_VAT).fils !== net.percent(VAT_PERCENT).fils) {
        throw new Error(`differs at ${f} fils`);
      }
    }
    for (let f = 200_000; f <= 50_000_000; f += 997) {
      const net = Money.fils(f);
      expect(vatOnNet(net, DEFAULT_VAT).fils).toBe(
        net.percent(VAT_PERCENT).fils,
      );
    }
  });

  it('charges another rate exclusive', () => {
    expect(
      vatOnNet(Money.fils(20000), { bps: 550, inclusive: false }).fils,
    ).toBe(1100);
    expect(vatOnNet(Money.fils(20000), { bps: 0, inclusive: false }).fils).toBe(
      0,
    );
  });
});

describe('vatInsideGross', () => {
  it('finds 5% inside a gross price, and net + VAT adds back', () => {
    const gross = Money.fils(21000);
    const vat = vatInsideGross(gross, { bps: 500, inclusive: true });
    expect(vat.fils).toBe(1000);
    expect(gross.minus(vat).fils).toBe(20000);
  });

  it('rounds once, half up', () => {
    // 5000 x 500 / 10500 = 238.09... -> 238 (the plan's deposit example).
    expect(
      vatInsideGross(Money.fils(5000), { bps: 500, inclusive: true }).fils,
    ).toBe(238);
  });
});

describe('the small rules', () => {
  it('labels whole and fractional rates', () => {
    expect(vatLabel(DEFAULT_VAT)).toBe('VAT 5%');
    expect(vatLabel({ bps: 550, inclusive: false })).toBe('VAT 5.5%');
    expect(vatLabel({ bps: 1250, inclusive: false })).toBe('VAT 12.5%');
  });

  it('refuses a rate no tenant can have', () => {
    expect(saneVatPolicy(DEFAULT_VAT)).toBe(true);
    expect(saneVatPolicy({ bps: -1, inclusive: false })).toBe(false);
    expect(saneVatPolicy({ bps: 10_001, inclusive: false })).toBe(false);
    expect(saneVatPolicy({ bps: 5.5, inclusive: false })).toBe(false);
  });
});
