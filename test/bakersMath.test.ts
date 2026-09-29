import { describe, expect, it } from 'vitest';
import { computeFormula, FormulaError, scaleFormula, summarize } from '../src/lib/bakersMath.js';
import { countryLoaf } from './helpers.js';

describe("baker's math", () => {
  it('matches the spec worked example in grams mode', () => {
    const ings = computeFormula('grams', countryLoaf().ingredients);
    expect(ings.map((i) => i.percent)).toEqual([90, 10, 75, 20, 2]);
    const s = summarize(ings);
    expect(s.total_dough_g).toBe(1970);
    expect(s.base_flour_g).toBe(1000);
    expect(s.total_flour_g).toBe(1100);
    expect(s.hydration_pct).toBeCloseTo(77.27, 2);
    expect(s.salt_pct).toBe(2);
    expect(s.prefermented_flour_pct).toBeCloseTo(9.09, 2);
  });

  it('excludes starter flour from the 100% base', () => {
    const ings = computeFormula('grams', [
      { name: 'Flour', role: 'flour', grams: 500 },
      { name: 'Starter', role: 'leaven', grams: 150, leaven_hydration: 50 },
    ]);
    expect(ings[1]!.percent).toBe(30);
    const s = summarize(ings);
    expect(s.total_flour_g).toBeCloseTo(600); // 150 g at 50% hydration = 100 g flour + 50 g water
    expect(s.hydration_pct).toBeCloseTo((50 / 600) * 100);
  });

  it('computes grams from percentages and a target dough weight', () => {
    const ings = computeFormula(
      'percent',
      [
        { name: 'Bread flour', role: 'flour', percent: 90 },
        { name: 'Whole wheat', role: 'flour', percent: 10 },
        { name: 'Water', role: 'water', percent: 75 },
        { name: 'Starter', role: 'leaven', percent: 20 },
        { name: 'Salt', role: 'salt', percent: 2 },
      ],
      { targetDoughG: 1970 },
    );
    expect(ings.map((i) => i.grams)).toEqual([900, 100, 750, 200, 20]);
  });

  it('leaves grams empty in percent mode with no flour weight', () => {
    const ings = computeFormula('percent', [{ name: 'Flour', role: 'flour', percent: 100 }]);
    expect(ings[0]!.grams).toBeNull();
    expect(summarize(ings).total_dough_g).toBeNull();
  });

  it('rejects flour percentages that do not total 100 and reports the gap', () => {
    try {
      computeFormula('percent', [
        { name: 'A', role: 'flour', percent: 80 },
        { name: 'B', role: 'flour', percent: 15 },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FormulaError);
      expect((err as FormulaError).code).toBe('flour_not_100');
      expect((err as FormulaError).details).toMatchObject({ gap_pct: 5 });
    }
  });

  it('gives no percentages when there is no flour yet', () => {
    const ings = computeFormula('grams', [{ name: 'Water', role: 'water', grams: 700 }]);
    expect(ings[0]!.percent).toBeNull();
  });

  it('scales by target dough weight, flour weight or factor', () => {
    const ings = computeFormula('grams', countryLoaf().ingredients);
    const twoLoaves = scaleFormula(ings, { target_dough_g: 2 * 985 });
    expect(twoLoaves.ingredients[0]!.grams).toBeCloseTo(900);
    expect(scaleFormula(ings, { target_dough_g: 985 }).scale_factor).toBeCloseTo(0.5);
    expect(scaleFormula(ings, { base_flour_g: 500 }).ingredients[2]!.grams).toBeCloseTo(375);
    expect(scaleFormula(ings, { scale_factor: 1.5 }).target_dough_g).toBeCloseTo(2955);
  });
});
