/**
 * Baker's math on the phone. Mirrors the API's rules (src/lib/bakersMath.ts at the repo root):
 * every percentage is relative to the flour-role ingredients added directly to the dough (100%).
 * A starter's own flour and water, split by its hydration, are NOT in that base, but they are
 * counted in total flour, hydration and prefermented flour in the summary.
 */
import type { FormulaSummary, Ingredient, InputMode } from './types';

export const DEFAULT_LEAVEN_HYDRATION = 100;
const FLOUR_TOLERANCE = 0.01;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isFlour = (i: Pick<Ingredient, 'role'>) => i.role === 'flour';

export interface Formula {
  mode: InputMode;
  ingredients: Ingredient[];
  /**
   * Weight of the 100% flour. Derived from the flour rows in grams mode; entered by the baker
   * (or solved from a target dough weight) in percent mode, and null until then.
   */
  baseFlourG: number | null;
}

export function hasFlour(ingredients: Ingredient[]): boolean {
  return ingredients.some(isFlour);
}

export function flourGrams(ingredients: Ingredient[]): number {
  return sum(ingredients.filter(isFlour).map((i) => i.grams ?? 0));
}

export function flourPercentTotal(ingredients: Ingredient[]): number {
  return sum(ingredients.filter(isFlour).map((i) => i.percent ?? 0));
}

/** How far the flour percentages are from 100 (positive: flour is missing). */
export function flourGap(ingredients: Ingredient[]): number {
  if (!hasFlour(ingredients)) return 0;
  const gap = 100 - flourPercentTotal(ingredients);
  return Math.abs(gap) <= FLOUR_TOLERANCE ? 0 : gap;
}

/** Builds a formula from stored ingredients, filling whichever side is missing. */
export function toFormula(mode: InputMode, ingredients: Ingredient[], baseFlourG?: number | null): Formula {
  const rows = ingredients.map((i) => ({ ...i }));
  if (mode === 'grams') return recompute({ mode, ingredients: rows, baseFlourG: null });
  let base = baseFlourG ?? null;
  if (base === null && rows.length && rows.every((r) => r.grams !== null) && hasFlour(rows)) {
    const g = flourGrams(rows);
    base = g > 0 ? g : null;
  }
  return recompute({ mode, ingredients: rows, baseFlourG: base });
}

/** Re-derives the non-source side of every row from the source side. */
export function recompute(f: Formula): Formula {
  const rows = f.ingredients.map((i) => ({ ...i }));
  if (f.mode === 'grams') {
    const base = flourGrams(rows);
    for (const r of rows) r.percent = base > 0 && r.grams !== null ? (r.grams / base) * 100 : null;
    return { mode: 'grams', ingredients: rows, baseFlourG: base > 0 ? base : null };
  }
  const base = hasFlour(rows) ? f.baseFlourG : null;
  for (const r of rows) r.grams = base !== null && r.percent !== null ? (r.percent * base) / 100 : null;
  return { mode: 'percent', ingredients: rows, baseFlourG: base };
}

/** The baker typed a gram weight into row `index`. */
export function setGrams(f: Formula, index: number, grams: number | null): Formula {
  const rows = f.ingredients.map((i) => ({ ...i }));
  const row = rows[index];
  if (f.mode === 'grams') {
    row.grams = grams;
    return recompute({ ...f, ingredients: rows });
  }
  // Percent mode: percentages are the source of truth.
  if (grams === null) {
    row.percent = null;
    return recompute({ ...f, ingredients: rows });
  }
  if (isFlour(row)) {
    // Keep the other flours' weights, so the base flour changes and the flour split is re-derived.
    const others = rows.filter((r, i) => i !== index && isFlour(r));
    const otherGrams = sum(others.map((r) => ((r.percent ?? 0) * (f.baseFlourG ?? 0)) / 100));
    const base = otherGrams + grams;
    if (base <= 0) return f;
    for (const r of others) r.percent = ((((r.percent ?? 0) * (f.baseFlourG ?? 0)) / 100) / base) * 100;
    row.percent = (grams / base) * 100;
    return recompute({ ...f, ingredients: rows, baseFlourG: base });
  }
  if (!f.baseFlourG) {
    // No flour weight yet: treat this row's grams as defining nothing; ask for a flour weight first.
    return f;
  }
  row.percent = (grams / f.baseFlourG) * 100;
  return recompute({ ...f, ingredients: rows });
}

/** The baker typed a percentage into row `index`. */
export function setPercent(f: Formula, index: number, percent: number | null): Formula {
  if (!hasFlour(f.ingredients)) return f;
  const rows = f.ingredients.map((i) => ({ ...i }));
  const row = rows[index];
  if (f.mode === 'percent') {
    row.percent = percent;
    return recompute({ ...f, ingredients: rows });
  }
  // Grams mode: grams are the source of truth.
  if (percent === null) {
    row.grams = null;
    return recompute({ ...f, ingredients: rows });
  }
  const base = flourGrams(rows);
  if (isFlour(row)) {
    // Hold the other flours' grams and solve this flour's weight to make up `percent` of the flour.
    const otherGrams = base - (row.grams ?? 0);
    if (percent >= 100 || otherGrams <= 0) return f;
    row.grams = (percent / (100 - percent)) * otherGrams;
    return recompute({ ...f, ingredients: rows });
  }
  if (base <= 0) return f;
  row.grams = (percent * base) / 100;
  return recompute({ ...f, ingredients: rows });
}

/** Percent mode: the baker set the flour weight (100%). */
export function setBaseFlour(f: Formula, baseFlourG: number | null): Formula {
  if (f.mode === 'grams') return scaleFormula(f, { base_flour_g: baseFlourG ?? undefined }).formula;
  return recompute({ ...f, baseFlourG: baseFlourG && baseFlourG > 0 ? baseFlourG : null });
}

/** Switches which side is the source of truth; values never change, so nothing drifts. */
export function setMode(f: Formula, mode: InputMode): Formula {
  if (mode === f.mode) return f;
  if (mode === 'percent') return { ...f, mode, baseFlourG: f.baseFlourG ?? (flourGrams(f.ingredients) || null) };
  // To grams: grams must exist for every row, otherwise keep what we can.
  const rows = f.ingredients.map((i) => ({ ...i, grams: i.grams ?? 0 }));
  return recompute({ mode, ingredients: rows, baseFlourG: null });
}

/**
 * Puts the remaining flour percentage on the last flour row. Only percent mode can have a gap:
 * in grams mode the flour percentages are derived from the weights and always total 100.
 */
export function fillFlourGap(f: Formula): Formula {
  const gap = flourGap(f.ingredients);
  if (gap === 0 || f.mode !== 'percent') return f;
  const lastFlour = f.ingredients.map(isFlour).lastIndexOf(true);
  const current = f.ingredients[lastFlour].percent ?? 0;
  return setPercent(f, lastFlour, Math.max(0, current + gap));
}

export function leavenParts(grams: number, hydrationPct: number) {
  const flour = grams / (1 + hydrationPct / 100);
  return { flour, water: grams - flour };
}

export function summarize(ingredients: Ingredient[]): FormulaSummary {
  const empty: FormulaSummary = {
    total_dough_g: null,
    total_flour_g: null,
    base_flour_g: null,
    hydration_pct: null,
    salt_pct: null,
    prefermented_flour_pct: null,
  };
  if (ingredients.length === 0 || ingredients.some((i) => i.grams === null)) return empty;
  const g = (role: Ingredient['role']) => sum(ingredients.filter((i) => i.role === role).map((i) => i.grams!));
  const base = g('flour');
  let leavenFlour = 0;
  let leavenWater = 0;
  for (const i of ingredients.filter((x) => x.role === 'leaven')) {
    const parts = leavenParts(i.grams!, i.leaven_hydration ?? DEFAULT_LEAVEN_HYDRATION);
    leavenFlour += parts.flour;
    leavenWater += parts.water;
  }
  const totalFlour = base + leavenFlour;
  const totalWater = g('water') + leavenWater;
  return {
    total_dough_g: sum(ingredients.map((i) => i.grams!)),
    total_flour_g: totalFlour,
    base_flour_g: base,
    hydration_pct: totalFlour > 0 ? (totalWater / totalFlour) * 100 : null,
    salt_pct: base > 0 ? (g('salt') / base) * 100 : null,
    prefermented_flour_pct: totalFlour > 0 ? (leavenFlour / totalFlour) * 100 : null,
  };
}

export interface ScaleRequest {
  target_dough_g?: number;
  base_flour_g?: number;
  scale_factor?: number;
}

/**
 * Scales a formula by target dough weight (loaves x weight per loaf is the same thing),
 * flour weight or a factor. Works from percentages so a percent-mode recipe with no grams
 * can be scaled. Percentages never change; only grams do.
 */
export function scaleFormula(f: Formula, req: ScaleRequest): { formula: Formula; scale_factor: number } {
  const rows = f.ingredients;
  const hasPercents = rows.length > 0 && hasFlour(rows) && rows.every((r) => r.percent !== null);
  const original = summarize(rows).total_dough_g;
  let base: number | null = null;
  if (req.base_flour_g) base = req.base_flour_g;
  else if (req.target_dough_g && hasPercents) base = (req.target_dough_g * 100) / sum(rows.map((r) => r.percent!));

  let scaled: Ingredient[];
  if (base !== null && hasPercents) {
    scaled = rows.map((r) => ({ ...r, grams: (r.percent! * base!) / 100 }));
  } else {
    let factor = req.scale_factor ?? 1;
    if (req.target_dough_g && original) factor = req.target_dough_g / original;
    scaled = rows.map((r) => ({ ...r, grams: r.grams === null ? null : r.grams * factor }));
  }
  const total = summarize(scaled).total_dough_g;
  const formula: Formula = { mode: f.mode, ingredients: scaled, baseFlourG: flourGrams(scaled) || null };
  return { formula, scale_factor: req.scale_factor ?? (original && total ? total / original : 1) };
}

/** Grams to 1 g, or 0.1 g for yeast and anything under 10 g. */
export function formatGrams(grams: number | null, role?: Ingredient['role']): string {
  if (grams === null || !Number.isFinite(grams)) return '';
  const fine = role === 'yeast' || Math.abs(grams) < 10;
  return fine ? String(round(grams, 1)) : String(Math.round(grams));
}

/** Percentages to 0.1%. */
export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '';
  return String(round(percent, 1));
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Parses what the baker typed; accepts a comma as the decimal separator. Empty means null. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
