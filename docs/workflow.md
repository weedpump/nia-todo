# Workflow

## Development

- work in the dev folder: `~/projects/nia-todo-dev`
- do not expect or modify live data on this host; production runs on a separate LXC

## Branches

- `develop` -> active development / current-codebase fixes
- `main` -> stable versions / tags

## Release

1. Merge feature branches into `develop` only after review; `release.sh` releases `develop` exclusively
2. Start the release script on `develop` with a clean working tree; feature branches are deliberately rejected
3. Stay in the dev folder: `~/projects/nia-todo-dev`
4. Run targeted tests beforehand if needed; `release.sh` runs the complete suite itself
5. Run `./release.sh VERSION --github-repo OWNER/REPO`, e.g. `./release.sh 2.6.4 --github-repo weedpump/nia-todo`; stable releases must use `MAJOR.MINOR.PATCH`
6. Optional: add `--set-min-app-version` only when older native apps must be blocked; without the flag, older native apps remain compatible
7. The script sets the same version for the web app, service worker, Tauri/Cargo, Windows installer, Android APK, Linux desktop `.deb`, and download manifest
8. `scripts/check_release_versions.py VERSION` aborts the release if an automatically set version source drifts; `min_native_client_version` is validated and only raised with the explicit release flag
9. The script always builds Windows, Android, and Linux desktop as well; separate app versions or optional native builds no longer exist
10. The script merges `develop` into `main`, creates the tag, builds public `.deb`/Docker artifacts, publishes GitHub/GHCR, cleans local release artifacts, and bumps `develop` to the next shared `-dev` version
11. The script does **not** deploy to or restart production. Production runs on a separate LXC and is updated by installing the published package/image.

Changelog requirement:

- `CHANGELOG.md` needs a `## [VERSION]` section for the shared web/Windows/Android/Linux version.
- Separate platform changelogs are no longer maintained.

Release artifacts exposed by an installed server under `/downloads/`:

- Windows: `nia-todo-vX.Y.Z-windows-x64-setup.exe`
- Android: `nia-todo-vX.Y.Z-android-arm64.apk`
- Linux desktop: `nia-todo-desktop-vX.Y.Z-linux-amd64.deb`
- Before the Android build, `release.sh` writes generated `src-tauri/gen/android/app/tauri.properties` to match the release version and checks it before/after the build.
- Manifest: `web/downloads/app-downloads.json` with `version`, `web_version`, `latest.version`, and each app artifact version on the release tag.
- `min_native_client_version` is not a release counter. A standard release leaves the boundary unchanged; only `--set-min-app-version` sets it in source/package defaults to the new release version when older native apps are truly incompatible or unsafe.
- During release packaging, the generated download manifest contains exactly the current Windows/Android/Linux artifacts; installed servers expose those files under `/downloads/`.
- Native builds use a freshly created `src-tauri/frontend-dist` without `web/downloads/`; size limits abort the release if installer/APK/desktop package artifacts unexpectedly become large.

Android is signed with the permanent release key:

- Keystore: `$NIA_TODO_SECRETS_DIR/nia-todo-android-release.keystore`
- Alias: `nia-todo-android-release`

The release key must stay backed up; changing the key breaks Android over-installs and the Android passkey binding through Digital Asset Links. A signing-key rotation therefore also needs a planned server/docs migration path for `/.well-known/assetlinks.json` and the allowed Android app origin.

Native build notes from `v1.6.0` onward:

- Windows installer includes the local reminder scheduler; reminders work offline as long as app/tray is running.
- Android APK includes the local `AlarmManager` scheduler; reminders work offline and are rescheduled after device reboot.
- Android passkeys require the bundled app ID `de.tobiaskneidl.nia_todo` and the release key; selfhosters connect the bundled app to their server URL.
- Browser/PWA push remains browser/PWA-only; native apps should not depend on the server WebSocket for reminders.
- Service worker remains active even in native wrappers so offline cold start works.
- After a successful release, `release.sh` cleans local Tauri build artifacts via `cargo clean --manifest-path src-tauri/Cargo.toml`. If needed, this can be skipped with `CLEAN_BUILD_ARTIFACTS_AFTER_RELEASE=0 ./release.sh VERSION --github-repo OWNER/REPO`.

## Dev Branding

- Dev branding is maintained through `setup-dev.sh`
- Do not manually touch `web/manifest.json` in the normal workflow

## Changes

- commit meaningful changes
- push after larger work blocks
- bundle small docs changes

## Auth/Admin/2FA Changes

- develop password/onboarding/2FA changes on feature branches
- validate email addresses client-side and server-side
- admins create password setup/reset links instead of setting passwords directly
- password links are single-use and valid for 24 hours
- 2FA changes must consider login MFA, reauth MFA, and sensitive actions separately: trusted devices/login MFA must not authorize any account security action
- recovery codes are only backup factors for TOTP/passkey; changes to them need at least `scripts/test_two_factor_services.py` and a focused security review
- before merge/release, run the focused tests matching the change; releases always run `./scripts/test_all.sh`
