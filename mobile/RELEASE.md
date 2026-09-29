# Getting Bakers Math onto phones and into the stores

The app is set up to build with EAS (Expo's cloud build service), so you don't need Xcode or
Android Studio. Everything below marked **You** needs your own accounts, money or signature and
can't be done from the repo.

## Read this first: the server problem

App Review (Apple) and Google's pre-launch review both sign in to the app and try it. Bakers Math
only works with a server you run on your home network, which reviewers can't reach, so a public
store release would be rejected for "app doesn't work" until there is a server on the internet
with a demo account (or a demo mode).

What works today without that:

| Route | Review needed | Who can install |
| ----- | ------------- | --------------- |
| **TestFlight, internal testing** (iPhone) | No | Up to 100 people on your App Store Connect team |
| **Play Console, internal testing** (Android) | No | Up to 100 testers by email |
| **EAS internal build** (`preview` profile) | No | Android: anyone with the APK link. iPhone: devices you register |

Recommendation: ship to yourself and friends through TestFlight internal testing and the Play
internal testing track now, and do the public store release together with cloud hosting later.

## One-time setup

1. **You: Apple Developer Program**, $99/year, at https://developer.apple.com/programs/enroll/.
   Enroll as an individual (no company or D-U-N-S number needed). Approval can take a day or two.
2. **You: Google Play developer account**, $25 once, at https://play.google.com/console/signup.
   Google verifies your identity. New personal accounts must run a closed test with at least 12
   testers for 14 days before they can publish to production; internal testing is available
   right away.
3. **You: Expo account**, free, at https://expo.dev/signup.
4. **You: pick the app ID.** It's `com.bakersmath.app` in `app.json` (`ios.bundleIdentifier` and
   `android.package`). It can't change after the first store upload. If you don't own
   bakersmath.com, something like `com.brianfarmer.bakersmath` is safer. Change both fields
   before the first build.
5. Link the project to Expo, from `mobile/`:

   ```sh
   npx eas-cli@latest login
   npx eas-cli@latest init        # adds your projectId and owner to app.json; commit that
   ```

## Signing (EAS does it; you approve it)

- **iPhone:** the first `eas build --platform ios` asks you to sign in with your Apple ID and
  offers to create the distribution certificate, provisioning profile and App ID for you. Say yes.
  Credentials are stored on Expo's servers; `npx eas-cli@latest credentials` shows them.
- **Android:** the first `eas build --platform android` offers to generate an upload keystore.
  Say yes, then download a backup with `npx eas-cli@latest credentials` and keep it somewhere safe.
  Turn on **Play App Signing** when you create the app in the Play Console (it's the default), so
  a lost upload key can be reset by Google.

## Builds

Profiles are in `eas.json`:

| Profile | What it makes | Use it for |
| ------- | ------------- | ---------- |
| `development` | A debug app with the Expo dev menu (like Expo Go, but with this app's native setup) | Testing notifications, camera and background upload on a real phone |
| `preview` | A release build installed directly: an APK on Android, an ad hoc build on iPhone | Handing the app to a few people without the stores |
| `production` | Store builds (AAB for Play, IPA for the App Store); build numbers go up automatically | TestFlight and the Play testing tracks |

```sh
npx eas-cli@latest build --profile preview --platform android
npx eas-cli@latest build --profile production --platform all
```

For iPhone `preview` and `development` builds, register each phone first with
`npx eas-cli@latest device:create`.

The version people see is `version` in `app.json` (1.0.0). Build numbers are kept by EAS
(`appVersionSource: remote`) and bumped on every production build.

## Getting builds to testers

- **iPhone:** `npx eas-cli@latest submit --platform ios --latest` uploads the last production
  build to App Store Connect (it creates the app record on first run). Once Apple finishes
  processing, add yourself and others under TestFlight > Internal Testing.
- **Android:** create the app in the Play Console first. Google requires the **first** upload to
  be done by hand: download the `.aab` from the EAS build page and upload it to Testing >
  Internal testing. After that, `eas submit --platform android` can upload for you if you create
  a Google Cloud service account key and add its path under `submit.production.android` in
  `eas.json` (don't commit the key).

## Store listing and forms

Listing text, keywords, privacy answers and screenshot sizes are in `store/listing.md`. The Play
feature graphic is `store/feature-graphic.png`.

- **You: publish a privacy policy.** Both stores require a public URL. Fill in the two
  placeholders in `store/privacy-policy.md` and publish it, e.g. as a GitHub Pages page or a
  public gist.
- **You: App Store Connect > App Privacy.** Answer from the table in `store/listing.md`.
- **You: Play Console > Data safety**, same answers. Also: content rating questionnaire, target
  audience (not for children), and "App access": explain that it needs a self-hosted server and
  give a demo server and account when one exists.
- **You: Play Console > exact alarm declaration.** The app asks for `SCHEDULE_EXACT_ALARM` so step
  timers go off on time. Declare it as a timer the user sets.
- **You: export compliance.** Already answered in `app.json` (`usesNonExemptEncryption: false`,
  the app uses only standard HTTPS), so App Store Connect won't ask on each build.
- **Account deletion** is required by both stores and is in the app (Profile > Delete account).
  Google also wants a web link for deletion requests; the privacy policy's contact address works.

## Things to know for App Review later

- `app.json` allows plain HTTP (`NSAllowsArbitraryLoads` on iPhone, cleartext traffic on Android)
  so the app can reach a home server. Apple asks for a reason in review: "users connect to a
  server they host on their own network". Once there's a cloud server with HTTPS, these can be
  narrowed or removed.
- The iPhone build is iPhone only (`supportsTablet: false`), so no iPad screenshots are needed.
  It still runs on iPads in iPhone mode.
- Background upload uses a background URL session, which needs no background mode. The unused
  `fetch` background mode was removed so review doesn't ask about it.

## Regenerating the icon

The icon, Android icon layers, splash mark, notification icon and feature graphic all come from
`scripts/render-icons.mjs`. Edit the SVG there and rerun it (instructions at the top of the file).
