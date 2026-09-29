# Bakers Math app

The Expo (React Native, TypeScript) app for Bakers Math: recipes in grams or baker's
percentages, guided bakes with step timers, a bake log with notes, photos and videos, and
offline use with sync. It talks to the API in the repo root.

Expo SDK 57, Expo Router. Everything it uses is in Expo Go, so no native build is needed to try it.

## Run it on your phone

1. Start the API on your computer (from the repo root). Set `S3_PUBLIC_ENDPOINT` in `.env` to
   your computer's LAN address so the phone can upload photos, as the root README explains:

   ```sh
   docker compose up --build
   ```

2. Start the app's dev server (from this folder):

   ```sh
   npm install
   npm start
   ```

3. Install **Expo Go** on the phone, make sure it's on the same Wi-Fi as the computer, and scan
   the QR code.

4. On the sign-in screen, check **Server address**. In Expo Go it's filled in with the computer
   that serves the app (the same one running the API), e.g. `http://192.168.1.20:3000/v1`.
   Tap **Test connection**, then create an account.

You can type just the address (`192.168.1.20`); port 3000 and `/v1` are added.

## Builds and the app stores

`RELEASE.md` covers building installable apps with EAS, signing, TestFlight and Play testing,
and what only you can do (developer accounts, store forms). Store copy and the privacy policy
draft are in `store/`.

## What's where

```
src/app/               screens (Expo Router: each file is a route)
  sign-in, reset-password
  (tabs)/              My Recipes, Discover, Bake Log, Profile
  recipe/[id]          recipe page: formula, steps, bakes, copy/download, public switch
  recipe/edit          editor: formula (grams and % side by side), steps, settings
  recipe/scale         scale by dough weight, loaves x weight, or flour weight, then start a bake
  recipe/versions      older versions kept after a conflicting edit
  bake/guided          guided mode: one step at a time with its timer
  bake/[id]            bake page: rating, notes, shared switch, photos/videos, step timings
  bake/media           full-screen photo and video
src/lib/               plain TypeScript, no React Native (unit tested)
  bakersMath.ts        live grams <-> % conversion, summary, scaling, rounding
  timer.ts             timers stored as absolute end times
  api.ts               API client with token refresh
  syncEngine.ts        push outbox, pull changes, upload media, most recent save wins
src/data/              the phone side: SQLite store, session, sync runner, media, notifications
test/                  vitest: unit tests and an end-to-end sync test against the API
scripts/render-icons   draws the icon, splash mark and store graphic from one SVG
store/                 store listing copy, privacy policy draft, Play feature graphic
```

## How it works

- **Baker's math.** Percentages are relative to the flour added directly to the dough (100%).
  A starter's flour and water are split by its hydration and counted in total flour, hydration
  and prefermented flour, not in the 100% (same rules as the API). Typing grams updates the
  percentages and vice versa; the recipe's mode only decides which side is stored as the source
  of truth. Values keep full precision; rounding is for display only (1 g, 0.1 g under 10 g and
  for yeast, 0.1%).
- **Offline first.** Recipes and bakes are saved to SQLite on the phone and queued in an outbox.
  Sync runs at launch, when the app returns to the foreground, when the network comes back,
  every minute, and shortly after each change. The header shows when you're offline and how
  many changes are waiting. When a recipe was edited on two devices, the most recent save wins
  and the other version is kept under **Older versions** on the recipe page.
- **Timers.** Running timers are stored as end times, so leaving the app loses nothing. Each
  running timer schedules a local notification with sound for its end, which fires with the
  phone locked or the app closed. The screen stays on in guided mode.
- **Photos and videos.** Captured or picked files are copied into the app's storage right away,
  then uploaded (on any connection) straight to storage with a presigned URL once their bake
  has synced. On iOS the upload continues in the background; an interrupted upload is retried
  with a fresh URL on the next sync.
- **Needs a connection:** Discover, copying a recipe, downloading one for offline, and switching
  a recipe between private and public.

## Checks

```sh
npm run typecheck
npm test
```

`npm test` skips the end-to-end sync test unless an API is running:

```sh
docker compose up -d                       # from the repo root
E2E_API_URL=http://localhost:3000/v1 npm test
```

CI runs all of this, including the end-to-end test against Postgres and MinIO, and bundles the
Android app.

## Notes

- Password reset: there's no email service yet, so the reset link is in the API log
  (`docker compose logs api`). Paste the link or its code on the reset screen.
- Steps are reordered with up and down buttons rather than drag and drop.
- A standalone build (`eas build`) allows plain HTTP to the local server: Android via
  `usesCleartextTraffic`, iOS via App Transport Security exceptions in `app.json`. Tighten these
  when the API moves to HTTPS hosting.
