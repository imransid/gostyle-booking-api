import { describe, it, expect } from 'vitest';
import { planPosSettlement } from './pos-settlement';

describe('planPosSettlement', () => {
  it('applies the whole deposit, VAT and all, when the bill needs it', () => {
    // The plan's worked example: AED 50 deposit, 238 fils of it VAT.
    expect(
      planPosSettlement(
        { balanceFils: 5000, vatFils: 238 },
        { appliedFils: 5000, appliedVatFils: 238 },
      ),
    ).toEqual({
      kind: 'rows',
      applied: { amountFils: -5000, vatFils: 238 },
      leftover: null,
    });
  });

  it('credits the leftover with exactly the VAT the till did not reverse', () => {
    // Bill smaller than the deposit: the till applied 3000 of 5000 and
    // reversed round(238 x 3000/5000) = 143. 95 is still declared, on 2000.
    expect(
      planPosSettlement(
        { balanceFils: 5000, vatFils: 238 },
        { appliedFils: 3000, appliedVatFils: 143 },
      ),
    ).toEqual({
      kind: 'rows',
      applied: { amountFils: -3000, vatFils: 143 },
      leftover: { amountFils: -2000, vatFils: 95 },
    });
  });

  it('writes nothing for a booking with no deposit', () => {
    expect(
      planPosSettlement(
        { balanceFils: 0, vatFils: 0 },
        { appliedFils: 0, appliedVatFils: 0 },
      ),
    ).toEqual({ kind: 'rows', applied: null, leftover: null });
  });

  it('credits the whole deposit back when the till applied none of it', () => {
    expect(
      planPosSettlement(
        { balanceFils: 5000, vatFils: 238 },
        { appliedFils: 0, appliedVatFils: 0 },
      ),
    ).toEqual({
      kind: 'rows',
      applied: null,
      leftover: { amountFils: -5000, vatFils: 238 },
    });
  });

  it('refuses a draw-down larger than what the booking holds', () => {
    const plan = planPosSettlement(
      { balanceFils: 4000, vatFils: 190 },
      { appliedFils: 5000, appliedVatFils: 238 },
    );
    expect(plan.kind).toBe('refused');
    expect(plan.kind === 'refused' && plan.code).toBe(
      'DEPOSIT_EXCEEDS_BALANCE',
    );
  });

  it.each([
    [-1, 0],
    [100, 101],
    [100.5, 0],
    [100, -1],
  ])('refuses applied %s with VAT %s', (appliedFils, appliedVatFils) => {
    const plan = planPosSettlement(
      { balanceFils: 5000, vatFils: 238 },
      { appliedFils, appliedVatFils },
    );
    expect(plan.kind === 'refused' && plan.code).toBe('INVALID_FIGURES');
  });

  it('never gives the leftover negative VAT when the till over-reversed', () => {
    const plan = planPosSettlement(
      { balanceFils: 5000, vatFils: 100 },
      { appliedFils: 3000, appliedVatFils: 143 },
    );
    expect(plan).toEqual({
      kind: 'rows',
      applied: { amountFils: -3000, vatFils: 143 },
      leftover: { amountFils: -2000, vatFils: 0 },
    });
  });
});
