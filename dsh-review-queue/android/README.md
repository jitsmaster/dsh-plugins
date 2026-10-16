# Review Queue Android shell (Trusted Web Activity)

A thin Android app that opens the hub's phone page (`/review-queue/m/`) full screen in Chrome (Trusted Web Activity, library
`androidbrowserhelper` 2.7.4). Design and decisions: [../docs/hub.md](../docs/hub.md) sections 4 and 11. This folder is **not** shipped in the
installed plugin (`package.json` "files" leaves it out).

## What is where

| Path | Purpose |
| --- | --- |
| `gradle.properties` | `rq.applicationId`, version code and name |
| `app/build.gradle.kts` | SDK 36 / minSdk 26, AGP 8.13.2, build types `debug`, `release`, `localDebug` |
| `app/src/main/AndroidManifest.xml` | LauncherActivity, pinned Chrome, asset statements, delegation service (off), POST_NOTIFICATIONS |
| `app/src/main/res/values/twa.xml` | **generated** (untracked): start URL, host, path prefix, asset_statements |
| `app/src/localDebug/res/values/twa.xml` | **generated** (untracked): loopback `http://127.0.0.1:<hubPort>/review-queue/m/`, only in the `localDebug` build type |
| `tools/*.mjs` | pure helpers with tests in `test/android-*.test.mjs` |
| `build.ps1` `install.ps1` `fingerprint.ps1` `adb-check.ps1` `make-release-key.ps1` | the commands below; `common.ps1` holds their shared helpers |

## One-time setup

1. JDK 17: unzip it anywhere and tell the scripts where: env `RQ_JDK17`, or untracked `android/local-tools.json` containing `{"jdk17": "C:/tools/jdk-17"}`, or pass `-Jdk <dir>`. A `JAVA_HOME` that is already set is the last fallback.
2. Android SDK with platform `android-36` (compileSdk/targetSdk 36; `sdkmanager "platforms;android-36"` with JDK 17) and build-tools 35.0.0 (apksigner): found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `%LOCALAPPDATA%\Android\Sdk`. `build.ps1` writes the untracked `local.properties` (`sdk.dir`) if it is missing.
3. Gradle wrapper: `gradle/wrapper/gradle-wrapper.jar` must be present (wrapper properties pin Gradle 8.13; `gradlew.bat` downloads the distribution on first use).
4. The hub's `hub.config.json` (`%USERPROFILE%\.dsh\review-queue\hub.config.json`) needs `publicUrl`, the https origin of the hub (for example `https://<node>.<tailnet>.ts.net`).
5. Release key (once): `./make-release-key.ps1` asks for a password (hidden), creates `%USERPROFILE%\.dsh\review-queue\android-signing\rq-release.jks` outside the repo and writes the untracked `keystore.properties` (shape: `keystore.properties.example`). Back the key file up; a lost key means uninstall and reinstall on the phone.

## Build, fingerprints, install

Run from `dsh-review-queue/android` in PowerShell 7:

```powershell
./build.ps1                    # debug APK:   app/build/outputs/apk/debug/app-debug.apk
./build.ps1 -Release           # release APK: app/build/outputs/apk/release/app-release.apk, checked with apksigner
./build.ps1 -LocalDebug        # emulator APK (package <id>.local) with the loopback start URL

./fingerprint.ps1              # SHA-256 of the release and debug certs -> hub.config.json android.sha256CertFingerprints
                               # (then restart the hub so /.well-known/assetlinks.json lists them)
./install.ps1 -Variant release -Launch          # adb install -r on the single online device
./install.ps1 -Variant localDebug -Serial emulator-5554 -Launch   # also adb reverse tcp:<hubPort>
./adb-check.ps1                # installed version, TWA vs Custom Tab launch, address bar, notifications
```

Without a `hub.config.json`, pass the URL directly: `./build.ps1 -StartUrl https://host.example.ts.net/review-queue/m/`.
Raw `gradlew.bat` works only after `build.ps1` (or `node tools/gen-resources.mjs`) has generated the `twa.xml` files.

## Notes

- Chrome verifies the app-to-site Digital Asset Links (the `asset_statements` here) and the site-to-app file the hub serves; if either fails, the page shows in a Custom Tab with an address bar. `adb-check.ps1` shows which case happened.
- The release build never contains the loopback URL; it exists only in the `localDebug` build type.
- Notification delegation is off (`res/values/bools.xml`); set `enable_notification_delegation` to `true` after the M0 test T5 if it is better.
- The scripts never print or embed passwords; `keystore.properties`, `*.jks` and `*.keystore` are git-ignored.
- No dependency pins: `androidbrowserhelper` 2.7.4 brings androidx.browser 1.10.0 and androidx.core 1.17.0, which need compileSdk 36. Pinning older versions (and compileSdk 35) builds, but the app then crashes at launch with `NoSuchMethodError WindowCompat.enableEdgeToEdge`.
- The manifest declares `ManageDataLauncherActivity` (library requirement: without it the launch crashes) and uses it as the manage-space / site-settings activity.
- Emulator test: `./build.ps1 -LocalDebug`, `./install.ps1 -Variant localDebug -Serial emulator-5554 -Launch` (or `adb reverse tcp:47615 tcp:47615` and `am start -n dev.dsh.reviewqueue.local/com.google.androidbrowserhelper.trusted.LauncherActivity`). Chrome cannot verify an http loopback origin, so the localDebug app opens the page in a **Custom Tab** with an address bar; full-screen verification can only be seen on the phone with the https name. Chrome shows its first-run screen once on a fresh emulator.
- `POST /hub/v1/shutdown` (hub restart after `fingerprint.ps1`) needs `Content-Type: application/json`, a body of `{}` and the headers `Authorization: Bearer <hub.secret>` and `X-RQ-Role: desktop`.
- `make-release-key.ps1` reads the password with a hidden prompt, so it cannot be driven by a pipe; for an unattended run create the key with `keytool` (same alias `rq`, same path) and write `keystore.properties` by hand (one `key=value` per line).
