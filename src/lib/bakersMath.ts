/**
 * Baker's math. Every percentage is relative to the flour-role ingredients added
 * directly to the dough (the 100% base). A starter's own flour and water are NOT in
 * that base, but they are counted in total hydration and prefermented flour.
 */

export type IngredientRole = 'flour' | 'water' | 'salt' | 'leaven' | 'yeast' | 'other_liquid' | 'other';
export type InputMode = 'grams' | 'percent';

export interface IngredientInput {
  id?: string;
  name: string;
  role: IngredientRole;
  grams?: number | null;
  percent?: number | null;
  leaven_hydration?: number | null;
}

export interface Ingredient extends IngredientInput {
  grams: number | null;
  percent: number | null;
  leaven_hydration: number | null;
}

export interface FormulaSummary {
  total_dough_g: number | null;
  /** Base flour (100%) plus flour inside leavens. */
  total_flour_g: number | null;
  base_flour_g: number | null;
  hydration_pct: number | null;
  salt_pct: number | null;
  prefermented_flour_pct: number | null;
}

export const DEFAULT_LEAVEN_HYDRATION = 100;
const FLOUR_TOTAL_TOLERANCE = 0.01;

export class FormulaError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Fills in whichever of grams/percent is not the source of truth.
 * In percent mode, grams are only computed when a flour weight is known: either
 * `baseFlourG` or a `targetDoughG` from which the flour weight is solved.
 */
export function computeFormula(
  mode: InputMode,
  inputs: IngredientInput[],
  opts: { baseFlourG?: number | null; targetDoughG?: number | null } = {},
): Ingredient[] {
  const rows = inputs.map((i) => ({
    ...i,
    grams: i.grams ?? null,
    percent: i.percent ?? null,
    leaven_hydration: i.role === 'leaven' ? (i.leaven_hydration ?? DEFAULT_LEAVEN_HYDRATION) : null,
  }));
  const flours = rows.filter((r) => r.role === 'flour');

  if (mode === 'grams') {
    for (const r of rows) {
      if (r.grams === null) throw new FormulaError('missing_grams', `"${r.name}" needs a grams value in grams mode`);
    }
    const base = sum(flours.map((r) => r.grams!));
    for (const r of rows) r.percent = base > 0 ? (r.grams! / base) * 100 : null;
    return rows;
  }

  for (const r of rows) {
    if (r.percent === null) throw new FormulaError('missing_percent', `"${r.name}" needs a percent value in percent mode`);
  }
  if (rows.length === 0) return rows;
  if (flours.length === 0) {
    throw new FormulaError('no_flour', 'Add a flour ingredient before using percentages');
  }
  const flourTotal = sum(flours.map((r) => r.percent!));
  if (Math.abs(flourTotal - 100) > FLOUR_TOTAL_TOLERANCE) {
    throw new FormulaError('flour_not_100', `Flour percentages add up to ${round(flourTotal, 2)}%, not 100%`, {
      flour_total_pct: flourTotal,
      gap_pct: 100 - flourTotal,
    });
  }
  let base: number | null = opts.baseFlourG ?? null;
  if (base === null && opts.targetDoughG) {
    base = (opts.targetDoughG * 100) / sum(rows.map((r) => r.percent!));
  }
  for (const r of rows) r.grams = base === null ? null : (r.percent! * base) / 100;
  return rows;
}

/** Splits a leaven's weight into its flour and water using its hydration. */
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
  const g = (role: IngredientRole) => sum(ingredients.filter((i) => i.role === role).map((i) => i.grams!));
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

/** Scale factor that turns the recipe's current dough weight into targetDoughG. */
export function scaleFactorFor(ingredients: Ingredient[], targetDoughG: number): number {
  const total = summarize(ingredients).total_dough_g;
  if (!total) throw new FormulaError('cannot_scale', 'Recipe has no gram weights to scale from');
  return targetDoughG / total;
}

export function scaleIngredients(ingredients: Ingredient[], factor: number): Ingredient[] {
  return ingredients.map((i) => ({ ...i, grams: i.grams === null ? null : i.grams * factor }));
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export interface ScaleRequest {
  scale_factor?: number | null;
  target_dough_g?: number | null;
  base_flour_g?: number | null;
}

/**
 * Scales a formula by a factor, a target dough weight (e.g. loaves x weight per loaf)
 * or a base flour weight. Works from percentages when the formula has flour, so a
 * percent-mode recipe with no gram weights can still be scaled.
 */
export function scaleFormula(ingredients: Ingredient[], req: ScaleRequest) {
  const hasPercents = ingredients.length > 0 && ingredients.every((i) => i.percent !== null);
  let baseFlour: number | null = null;
  if (req.base_flour_g) baseFlour = req.base_flour_g;
  else if (req.target_dough_g && hasPercents) {
    baseFlour = (req.target_dough_g * 100) / sum(ingredients.map((i) => i.percent!));
  }

  let scaled: Ingredient[];
  if (baseFlour !== null && hasPercents) {
    scaled = ingredients.map((i) => ({ ...i, grams: (i.percent! * baseFlour!) / 100 }));
  } else {
    let factor = req.scale_factor ?? 1;
    if (req.target_dough_g) factor = scaleFactorFor(ingredients, req.target_dough_g);
    else if (req.base_flour_g) throw new FormulaError('cannot_scale', 'Recipe has no flour to scale by');
    if (ingredients.some((i) => i.grams === null)) {
      throw new FormulaError('cannot_scale', 'Give a target dough weight or flour weight to turn percentages into grams');
    }
    scaled = scaleIngredients(ingredients, factor);
  }
  const original = summarize(ingredients).total_dough_g;
  const total = summarize(scaled).total_dough_g!;
  return {
    ingredients: scaled,
    scale_factor: req.scale_factor ?? (original ? total / original : 1),
    target_dough_g: total,
  };
}
