import { describe, expect, it } from 'vitest';
import {
  fillFlourGap,
  flourGap,
  formatGrams,
  formatPercent,
  parseNumber,
  scaleFormula,
  setBaseFlour,
  setGrams,
  setMode,
  setPercent,
  summarize,
  toFormula,
} from '../src/lib/bakersMath';
import type { Ingredient } from '../src/lib/types';

const ing = (name: string, role: Ingredient['role'], grams: number | null, percent: number | null = null): Ingredient => ({
  id: name,
  name,
  role,
  grams,
  percent,
  leaven_hydration: role === 'leaven' ? 100 : null,
});

// The spec's worked example.
const example = () => [
  ing('Bread flour', 'flour', 900),
  ing('Whole wheat flour', 'flour', 100),
  ing('Water', 'water', 750),
  ing('Starter', 'leaven', 200),
  ing('Salt', 'salt', 20),
];

describe("baker's math", () => {
  it('matches the worked example: starter flour is not in the 100% base', () => {
    const f = toFormula('grams', example());
    expect(f.ingredients.map((i) => i.percent)).toEqual([90, 10, 75, 20, 2]);
    const s = summarize(f.ingredients);
    expect(s.total_dough_g).toBe(1970);
    expect(s.base_flour_g).toBe(1000);
    expect(s.total_flour_g).toBe(1100);
    expect(s.hydration_pct!).toBeCloseTo(77.27, 2);
    expect(s.prefermented_flour_pct!).toBeCloseTo(9.09, 2);
    expect(s.salt_pct).toBe(2);
  });

  it('uses the starter hydration to split it', () => {
    const rows = example();
    rows[3].leaven_hydration = 50;
    const s = summarize(toFormula('grams', rows).ingredients);
    // 200 g at 50% = 133.3 flour + 66.7 water
    expect(s.hydration_pct!).toBeCloseTo(((750 + 200 / 3) / (1000 + 400 / 3)) * 100, 6);
  });

  it('grams mode: editing grams updates percentages live', () => {
    let f = toFormula('grams', example());
    f = setGrams(f, 2, 800);
    expect(f.ingredients[2].percent).toBe(80);
    // Changing a flour changes the base, so every percentage moves.
    f = setGrams(f, 0, 1900);
    expect(f.ingredients[0].percent).toBeCloseTo(95, 6);
    expect(f.ingredients[2].percent).toBeCloseTo(40, 6);
  });

  it('grams mode: editing a percentage sets the grams', () => {
    let f = toFormula('grams', example());
    f = setPercent(f, 4, 2.5);
    expect(f.ingredients[4].grams).toBe(25);
    // A flour's percentage holds the other flours and solves for this one.
    f = setPercent(f, 1, 20);
    expect(f.ingredients[1].grams).toBeCloseTo(225, 6);
    expect(f.ingredients[0].percent).toBeCloseTo(80, 6);
  });

  it('percent mode: needs a flour weight before grams appear', () => {
    const rows = example().map((i) => ({ ...i, grams: null, percent: null }));
    let f = toFormula('percent', rows);
    for (const [i, p] of [90, 10, 75, 20, 2].entries()) f = setPercent(f, i, p);
    expect(f.ingredients.every((i) => i.grams === null)).toBe(true);
    f = setBaseFlour(f, 500);
    expect(f.ingredients.map((i) => i.grams)).toEqual([450, 50, 375, 100, 10]);
    // Editing grams of a non-flour changes its percentage.
    f = setGrams(f, 2, 400);
    expect(f.ingredients[2].percent).toBe(80);
  });

  it('shows the flour gap and fills it on the last flour', () => {
    let f = toFormula('percent', example().map((i) => ({ ...i, grams: null })), 1000);
    f = setPercent(f, 0, 90);
    f = setPercent(f, 1, 5);
    expect(flourGap(f.ingredients)).toBeCloseTo(5, 6);
    f = fillFlourGap(f);
    expect(flourGap(f.ingredients)).toBe(0);
    expect(f.ingredients[1].percent).toBeCloseTo(10, 6);
  });

  it('percentages are disabled with no flour', () => {
    const f = toFormula('grams', [ing('Water', 'water', 100)]);
    expect(f.ingredients[0].percent).toBeNull();
    expect(setPercent(f, 0, 50)).toBe(f);
  });

  it('switching modes never drifts', () => {
    let f = toFormula('grams', example());
    f = setGrams(f, 4, 21.3);
    const before = f.ingredients.map((i) => [i.grams, i.percent]);
    f = setMode(setMode(f, 'percent'), 'grams');
    expect(f.ingredients.map((i) => [i.grams, i.percent])).toEqual(before);
  });

  it('scales by dough weight, flour weight and loaves', () => {
    const f = toFormula('grams', example());
    const byDough = scaleFormula(f, { target_dough_g: 985 });
    expect(byDough.formula.ingredients.map((i) => i.grams)).toEqual([450, 50, 375, 100, 10]);
    expect(byDough.scale_factor).toBeCloseTo(0.5, 6);
    const byFlour = scaleFormula(f, { base_flour_g: 2000 });
    expect(summarize(byFlour.formula.ingredients).total_dough_g).toBe(3940);
    const loaves = scaleFormula(f, { target_dough_g: 3 * 900 });
    expect(summarize(loaves.formula.ingredients).total_dough_g).toBeCloseTo(2700, 6);
    // Percentages never change.
    expect(loaves.formula.ingredients.map((i) => i.percent)).toEqual([90, 10, 75, 20, 2]);
  });

  it('rounds for display only', () => {
    expect(formatGrams(1234.56)).toBe('1235');
    expect(formatGrams(7.26)).toBe('7.3');
    expect(formatGrams(12.34, 'yeast')).toBe('12.3');
    expect(formatPercent(77.2727)).toBe('77.3');
    expect(parseNumber('2,5')).toBe(2.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});
