# Bakers Math API

REST API for the Bakers Math bread recipe app: accounts, recipes in grams or baker's
percentages, bakes with step timings, notes, photos and videos, and offline sync.

Node 22 + TypeScript (Fastify), Postgres 16, and MinIO for media. Built from the
[product spec](https://claude.ai/code/artifact/75d1c853-cc27-4aae-83d8-999e6a433cb1).

The phone app (Expo) is in [`mobile/`](mobile/README.md).

## Run it locally

```sh
docker compose up --build
```

That starts three containers:

| Service  | Port | What it is |
| -------- | ---- | ---------- |
| api      | 3000 | This API. Applies database migrations and creates the media bucket on start. |
| postgres | 5432 | Database (user `bakers`, password `bakers`, db `bakers_math`). |
| minio    | 9000 / 9001 | S3-compatible storage for photos and videos; web console on 9001. |

Check it's up: `curl http://localhost:3000/health`.

### Using it from a phone on the same Wi-Fi

The app talks to `http://<your computer's LAN address>:3000/v1`. Photos and videos upload
straight to MinIO through presigned URLs, so those URLs must also use an address the phone
can reach. Before starting, create a `.env` next to `docker-compose.yml`:

```sh
S3_PUBLIC_ENDPOINT=http://192.168.1.20:9000   # your computer's LAN address
JWT_SECRET=some-long-random-string
```

### Development without Docker for the API

```sh
docker compose up -d postgres minio
npm install
npm run dev          # tsx watch, reads DATABASE_URL / S3_* from the environment (see .env.example)
```

### Tests

The tests run against the real Postgres and MinIO from compose (a separate
`bakers_math_test` database is recreated on each run).

```sh
docker compose up -d postgres minio
npm test
npm run typecheck
```

### Password reset emails

There is no email service yet. `POST /v1/auth/password-reset` writes the reset link to the
API log (`docker compose logs api`). Swap in a real mailer through the `mailer` option of
`buildApp` in `src/app.ts`.

## API

All routes are under `/v1`, take and return JSON, and (except sign-up, login, refresh,
logout and password reset) need `Authorization: Bearer <access token>`.

- Errors: `{ "error": { "code", "message", "details"? } }`. 400 bad input, 401 not signed
  in, 404 not found (also for someone else's private recipe or bake), 409 conflict,
  413 media too large, 422 formula problem (for example `flour_not_100`, whose details give
  the gap).
- Lists: `?cursor=&limit=` (default 20, max 100); responses are `{ items, next_cursor }`.
- Ids: the app may create UUIDs itself (`id` in create bodies) so rows made offline keep
  their id. Retrying a create with the same id is safe.
- `PUT`/`PATCH` accept `If-Unmodified-Since` (HTTP date or ISO timestamp, e.g. the
  `updated_at` you last saw). If the server copy is newer you get 409 `modified_since` with
  the server version in `error.details.current`.

### Auth and account

| Method | Path | Body / notes |
| ------ | ---- | ------------ |
| POST | `/auth/signup` | `{ email, password (8+), display_name? }` → `{ user, access_token, refresh_token, expires_in }` |
| POST | `/auth/login` | `{ email, password }` → same as signup |
| POST | `/auth/refresh` | `{ refresh_token }` → new token pair; the old refresh token stops working |
| POST | `/auth/logout` | `{ refresh_token }` |
| POST | `/auth/password-reset` | `{ email }` → always 202 |
| POST | `/auth/password-reset/confirm` | `{ token, password }`; signs out every device |
| GET / PATCH | `/me` | `{ display_name }` |
| DELETE | `/me` | Deletes the account, recipes, bakes and media |
| GET | `/me/downloads` | Public recipes kept offline |
| PUT / DELETE | `/me/downloads/{recipeId}` | Keep / stop keeping a public recipe offline |

Access tokens last 15 minutes, refresh tokens 30 days (one per signed-in device).

### Recipes

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/recipes?q=&tag=` | Own recipes, most recently changed first |
| POST | `/recipes` | Recipe with `ingredients` and `steps` arrays |
| GET | `/recipes/{id}` | Own, or anyone's public recipe |
| PUT | `/recipes/{id}` | Replace the recipe with its ingredients and steps |
| PATCH | `/recipes/{id}` | `name`, `description`, `visibility`, `tags`, `yield_count`, `yield_unit_weight_g` |
| DELETE | `/recipes/{id}` | Soft delete |
| POST | `/recipes/{id}/copy` | Copy a public recipe into your library (`copied_from_id` is set) |
| GET | `/recipes/{id}/shared-bakes` | Everyone's shared bakes of a recipe you can see |
| GET | `/public/recipes?q=&tag=&sort=recent` | Discover |

Recipe body:

```json
{
  "name": "Country loaf",
  "description": "",
  "visibility": "private",
  "input_mode": "grams",
  "yield_count": 2,
  "yield_unit_weight_g": 985,
  "tags": ["sourdough"],
  "ingredients": [
    { "name": "Bread flour", "role": "flour", "grams": 900 },
    { "name": "Whole wheat flour", "role": "flour", "grams": 100 },
    { "name": "Water", "role": "water", "grams": 750 },
    { "name": "Starter", "role": "leaven", "grams": 200, "leaven_hydration": 100 },
    { "name": "Salt", "role": "salt", "grams": 20 }
  ],
  "steps": [
    { "title": "Bulk", "instructions": "Folds every 30 min", "timer_seconds": 14400, "auto_start": false }
  ]
}
```

- Roles: `flour`, `water`, `salt`, `leaven`, `yeast`, `other_liquid`, `other`.
- In `grams` mode each ingredient needs `grams` and the server computes `percent`. In
  `percent` mode each needs `percent`, flour percentages must total 100, and grams are
  computed only if you also send `base_flour_g` or `target_dough_g`.
- Responses include a `summary`: `total_dough_g`, `base_flour_g`, `total_flour_g`,
  `hydration_pct`, `salt_pct`, `prefermented_flour_pct` (nulls until grams are known).

**Baker's math rule:** percentages are relative to the flour-role ingredients added directly
to the dough (100%). A starter's own flour and water, split using its `leaven_hydration`
(default 100%), are not in that base but are counted in total flour, hydration and
prefermented flour. The spec's worked example gives 1970 g, 77.3% hydration and 9.1%
prefermented flour (see `test/bakersMath.test.ts`).

### Bakes, step timings and media

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/bakes?recipe_id=` | Own bakes, newest first, with steps and media |
| POST | `/recipes/{id}/bakes` | `{ target_dough_g? , base_flour_g?, scale_factor?, started_at?, visibility?, notes? }`; stores the scaled recipe snapshot |
| GET | `/bakes/{id}` | Own, or someone's shared bake on a recipe you can see |
| PATCH | `/bakes/{id}` | `notes`, `rating` (1–5), `visibility` (`private`/`shared`), `current_step_position`, `finished_at` |
| PUT | `/bakes/{id}/steps/{stepId}` | `{ started_at?, ended_at?, actual_seconds?, note? }` (actual_seconds is worked out from the times if left out) |
| DELETE | `/bakes/{id}` | Deletes the bake and its media |
| POST | `/bakes/{id}/media` | `{ kind, content_type, bytes, duration_seconds?, width?, height? }` → `{ media, upload: { method, url, headers, expires_at } }` |
| POST | `/media/{id}/complete` | Call after the upload finishes; checks the file and marks it ready |
| GET | `/media/{id}` | `{ media, url, expires_at }` with a 15-minute download URL |
| DELETE | `/media/{id}` | |

Uploading a photo or video: request an upload, `PUT` the file to `upload.url` with exactly
the `upload.headers` given (the size is part of the signature), then call `complete`.
Photos up to 20 MB (jpeg, png, heic, heif, webp); videos up to 200 MB and 3 minutes (mp4,
mov). Asking again with the same media `id` hands out a fresh upload URL, so the app can retry an
upload that was interrupted (for example when it was backgrounded).

Timers run on the phone; the server only records step start and end times.

### Offline sync

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/sync?since=` | Everything changed since `since` (omit on first sync) |
| POST | `/sync` | Push queued changes: `{ recipes: [...], bakes: [...] }` |

`GET /sync` returns `{ server_time, recipes, removed_recipe_ids, bakes }`. Pass
`server_time` as `since` next time. `recipes` holds your own recipes (deleted ones come back
with `deleted_at` set) and public recipes you downloaded. `removed_recipe_ids` lists
downloaded recipes you should drop because their owner deleted them or made them private,
or you removed the download. Rows can repeat across two pulls; apply them idempotently.

`POST /sync` items are full recipes (same shape as `POST /recipes`, plus required `id` and
`modified_at`, optional `deleted_at`) and bakes (`id`, `recipe_id`, `modified_at`, the bake
fields, optional `recipe_snapshot` for bakes started offline, and `steps: [{ step_id, ... }]`).
`modified_at` is when the baker saved on the phone: the most recent save wins. Each item gets
back `{ id, status, server }` where status is `applied`, `stale` (the server copy is newer; keep
yours as the restorable older version) or `error` (with `error.code`). One bad item doesn't
fail the rest. Sync can't change a recipe's visibility; that needs `PATCH /recipes/{id}`.
Media is uploaded through the media endpoints after its bake has synced.

## Code layout

```
migrations/        SQL migrations, applied in order on start (npm run migrate to run by hand)
src/app.ts         Fastify app, error handling, route registration
src/lib/           baker's math, auth tokens, storage, pagination, validation
src/services/      recipe and bake loading/writing shared by the routes and sync
src/routes/        one file per area: auth, me, recipes, bakes, media, sync
test/              integration tests against Postgres and MinIO
```

## Notes and choices beyond the spec

- Two tables beyond the spec's eight: `password_resets` (reset links) and
  `recipe_downloads` (public recipes kept offline).
- Recipes and bakes carry `modified_at` (when the baker saved, from the phone's clock) next to
  `updated_at` (when the server last changed the row). Sync decides conflicts with
  `modified_at` and uses `updated_at` for its cursor.
- MinIO no longer publishes images on Docker Hub, so compose uses the community fork's build
  (`pgsty/minio`). Set `MINIO_IMAGE` to use a different image.
- Not built yet: rate limiting on sign-in, a real email sender, and cleaning up uploads that
  were requested but never completed.
