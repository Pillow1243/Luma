# Luma — Android platform

## Capacitor debug preview

The Capacitor app serves the embedded `dist/` from the same secure local origin
both online and offline; cached history and the outbox therefore share one
IndexedDB. It needs an online sign-in and a visited conversation before it can
show cached history. It is not automatically updated when the website changes.

```bash
npm ci
npm run build
npx cap add android
node scripts/configure-capacitor-android.mjs
npx cap sync android
cd android && ./gradlew assembleDebug
# android/app/build/outputs/apk/debug/app-debug.apk
```

Requires Node 22, JDK 21, Android SDK platform 35 and access to Gradle/Google
Maven. `android/` is generated and ignored. The configuration script adds
camera/microphone permissions, Luma icons and invite-link handling. For a dev
server only, set `LUMA_SERVER_URL` before `npx cap sync android`.

The Android debug workflow builds a Capacitor APK and publishes a **debug
prerelease** plus a 30-day workflow artifact. Debug signing is not the existing
Luma release key: it cannot update a release-signed installation in place.
Uninstalling an existing app can destroy local history and irrecoverable
secret-chat keys. Do not uninstall without understanding that loss. Screen
sharing may not be supported in Android WebView.

## Release signing

A distributable upgrade of an existing release requires the original Luma
keystore and password, deliberately absent from this repository. Do not
replace it with a new key and describe the result as an in-place update.
Configure an Android release signing setup with that key in a trusted build
environment. Never commit the keystore or password.

## Legacy Gradle-free shell

`scripts/build-apk.mjs` and `mobile/apk-shell/` remain as the older standalone
WebView shell, distinct from Capacitor. It loads the live Vercel URL and falls
back to a separate bundled `file:` origin. That fallback does not share the
live site's browser storage, so it cannot promise the same offline history as
the Capacitor build. Its signed release path requires the original keystore and
`LUMA_KEYSTORE_PASS`.
