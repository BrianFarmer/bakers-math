/** Shapes shared with the API (see the repo README). */

export type IngredientRole = 'flour' | 'water' | 'salt' | 'leaven' | 'yeast' | 'other_liquid' | 'other';
export type InputMode = 'grams' | 'percent';
export type RecipeVisibility = 'private' | 'public';
export type BakeVisibility = 'private' | 'shared';

export const ROLES: { value: IngredientRole; label: string }[] = [
  { value: 'flour', label: 'Flour' },
  { value: 'water', label: 'Water' },
  { value: 'salt', label: 'Salt' },
  { value: 'leaven', label: 'Starter' },
  { value: 'yeast', label: 'Yeast' },
  { value: 'other_liquid', label: 'Other liquid' },
  { value: 'other', label: 'Other' },
];

export interface Ingredient {
  id: string;
  name: string;
  role: IngredientRole;
  grams: number | null;
  percent: number | null;
  leaven_hydration: number | null;
}

export interface Step {
  id: string;
  title: string;
  instructions: string;
  timer_seconds: number | null;
  auto_start: boolean;
}

export interface FormulaSummary {
  total_dough_g: number | null;
  total_flour_g: number | null;
  base_flour_g: number | null;
  hydration_pct: number | null;
  salt_pct: number | null;
  prefermented_flour_pct: number | null;
}

export interface Recipe {
  id: string;
  owner: { id: string; display_name: string };
  name: string;
  description: string;
  visibility: RecipeVisibility;
  input_mode: InputMode;
  yield_count: number | null;
  yield_unit_weight_g: number | null;
  tags: string[];
  copied_from_id: string | null;
  published_at: string | null;
  modified_at: string;
  deleted_at: string | null;
  created_at?: string;
  updated_at?: string;
  ingredients: Ingredient[];
  steps: Step[];
  summary?: FormulaSummary;
  /** Phone only: flour weight (100%) for percent-mode recipes, so grams can be shown. */
  base_flour_g?: number | null;
}

export interface RecipeSnapshot {
  id: string;
  name: string;
  input_mode: InputMode;
  ingredients: Ingredient[];
  steps: Step[];
  summary: FormulaSummary;
  snapshot_at: string;
}

export interface BakeStep {
  step_id: string;
  started_at: string | null;
  ended_at: string | null;
  actual_seconds: number | null;
  note: string;
}

export interface MediaItem {
  id: string;
  bake_id: string;
  kind: 'photo' | 'video';
  content_type: string;
  bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  status: 'pending' | 'ready';
  created_at?: string;
}

export interface Bake {
  id: string;
  recipe_id: string;
  user?: { id: string; display_name: string };
  started_at: string;
  finished_at: string | null;
  scale_factor: number;
  target_dough_g: number | null;
  rating: number | null;
  notes: string;
  visibility: BakeVisibility;
  current_step_position: number | null;
  recipe_snapshot: RecipeSnapshot;
  modified_at: string;
  deleted_at: string | null;
  updated_at?: string;
  steps: BakeStep[];
  media: MediaItem[];
}

export interface User {
  id: string;
  email: string;
  display_name: string;
}
