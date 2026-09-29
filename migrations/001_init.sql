-- Bakers Math initial schema. See the product spec's "Data model" section.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Not in the spec's table list: needed for the password reset flow.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE recipe_visibility AS ENUM ('private', 'public');
CREATE TYPE input_mode AS ENUM ('grams', 'percent');
CREATE TYPE ingredient_role AS ENUM ('flour', 'water', 'salt', 'leaven', 'yeast', 'other_liquid', 'other');
CREATE TYPE bake_visibility AS ENUM ('private', 'shared');
CREATE TYPE media_kind AS ENUM ('photo', 'video');
CREATE TYPE media_status AS ENUM ('pending', 'ready');

CREATE TABLE recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  visibility recipe_visibility NOT NULL DEFAULT 'private',
  input_mode input_mode NOT NULL DEFAULT 'grams',
  yield_count integer,
  yield_unit_weight_g numeric,
  tags text[] NOT NULL DEFAULT '{}',
  copied_from_id uuid REFERENCES recipes(id) ON DELETE SET NULL,
  published_at timestamptz,
  -- When the baker saved this version (client clock). Used for last-save-wins sync.
  modified_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipes_owner_idx ON recipes (owner_id, updated_at);
CREATE INDEX recipes_visibility_name_idx ON recipes (visibility, name);
CREATE INDEX recipes_public_recent_idx ON recipes (published_at DESC, id) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX recipes_tags_idx ON recipes USING gin (tags);

CREATE TABLE ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  role ingredient_role NOT NULL,
  grams numeric,
  percent numeric,
  leaven_hydration numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingredients_recipe_idx ON ingredients (recipe_id, position);

CREATE TABLE steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  timer_seconds integer CHECK (timer_seconds IS NULL OR timer_seconds > 0),
  auto_start boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX steps_recipe_idx ON steps (recipe_id, position);

CREATE TABLE bakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scale_factor numeric NOT NULL DEFAULT 1,
  target_dough_g numeric,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  notes text NOT NULL DEFAULT '',
  visibility bake_visibility NOT NULL DEFAULT 'private',
  current_step_position integer,
  recipe_snapshot jsonb NOT NULL,
  modified_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bakes_user_idx ON bakes (user_id, started_at DESC, id);
CREATE INDEX bakes_recipe_shared_idx ON bakes (recipe_id, started_at DESC) WHERE visibility = 'shared' AND deleted_at IS NULL;
CREATE INDEX bakes_user_updated_idx ON bakes (user_id, updated_at);

CREATE TABLE bake_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bake_id uuid NOT NULL REFERENCES bakes(id) ON DELETE CASCADE,
  -- Steps can be deleted from the recipe later; the bake keeps its snapshot.
  step_id uuid NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  actual_seconds integer,
  note text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bake_id, step_id)
);

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bake_id uuid NOT NULL REFERENCES bakes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind media_kind NOT NULL,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  bytes bigint NOT NULL,
  duration_seconds numeric,
  width integer,
  height integer,
  status media_status NOT NULL DEFAULT 'pending',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_bake_idx ON media (bake_id);

-- Not in the spec's table list: public recipes a baker keeps offline (PUT /v1/me/downloads/{id}).
CREATE TABLE recipe_downloads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recipe_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','refresh_tokens','password_resets','recipes','ingredients','steps','bakes','bake_steps','media','recipe_downloads']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
