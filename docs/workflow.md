# Workflow

## Development

- work in your local dev checkout; scripts read the path from `NIA_TODO_DEV_DIR` (defaults to the repo root)
- do not expect or modify live data on this host; production runs on a separate LXC
- commit/push to `develop` as normal; this does **not** trigger CI

## Branches

- `develop` -> active development / current-codebase fixes
- `main` -> stable versions / tags

## Workflows

Three files, no duplicated build logic:

- **`tests.yml`**: runs `./scripts/test_all.sh` automatically on pull requests and on every push to `main`. Plain pushes to `develop` do not trigger it. Also runs standalone via manual dispatch, and is reused (`workflow_call`) by `release.yml` so releases don't run a second copy of the test job.
- **`build.yml`**: the single source of truth for building Windows/Android/Debian-desktop/Docker/the full server `.deb`. Triggered manually for ad-hoc test builds (tick only the packages you want; Docker/server-.deb always embed native apps - freshly built ones if selected, otherwise auto-fetched from the latest published GitHub release) - and reused by `release.yml` with a real version and all five packages enabled.
- **`release.yml`**: tag-triggered. Calls `tests.yml`, bumps the version and moves the tag, calls `build.yml` with the real version (which also pushes the Docker image directly to GHCR/Docker Hub), then creates the GitHub release from the built server `.deb` and bumps `develop` to the next `-dev` version.

## Release

Releases are entirely manual to trigger, then fully automatic:

1. Merge `develop` into `main` yourself (`git checkout main && git merge develop`), whenever you consider it ready.
2. Add a `CHANGELOG.md` section for the version first: `## [VERSION] - YYYY-MM-DD`.
3. Tag `main` and push the tag: `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`.
4. Pushing the tag triggers the release workflow, which:
   - runs the full test suite
   - bumps the shared version (web app, service worker, Tauri/Cargo, Android) from the tag name via `scripts/release/prepare-release-version.sh`, commits it on `main`, and **force-moves the tag** onto that commit so the tag always points at the exact code that was built
   - builds Windows, Android, and Debian desktop apps, plus the Docker image and full server `.deb`
   - publishes the GitHub release (assets + checksums), and pushes images to GHCR + Docker Hub
   - bumps `develop` to the next `-dev` patch version

Optional: re-run the workflow with `set_min_app_version: true` only when older native apps must be forced to update; without it, older native apps remain compatible.

Required GitHub repo secrets before the release workflow can run: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASS`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

`scripts/check_release_versions.py VERSION` aborts the release if an automatically set version source drifts; `min_native_client_version` is validated and only raised with the explicit flag.

The release workflow does **not** deploy to or restart production. Production runs on a separate LXC and is updated by installing the published package/image.

Release artifacts exposed by an installed server under `/downloads/`:

- Windows: `nia-todo-vX.Y.Z-windows-x64-setup.exe`
- Android: `nia-todo-vX.Y.Z-android-arm64.apk`
- Debian desktop: `nia-todo-desktop-vX.Y.Z-debian-amd64.deb`
- Manifest: `web/downloads/app-downloads.json` with `version`, `web_version`, `latest.version`, and each app artifact version on the release tag.
- `min_native_client_version` is not a release counter. A standard release leaves the boundary unchanged; only the explicit flag sets it to the new release version when older native apps are truly incompatible or unsafe.
- Native builds use a freshly created `src-tauri/frontend-dist` without `web/downloads/`; size limits abort the release if installer/APK/desktop package artifacts unexpectedly become large.

Android is signed with the permanent release key:

- Keystore: restored in CI from the `ANDROID_KEYSTORE_BASE64`/`ANDROID_KEYSTORE_PASS` secrets (see `release.yml`); locally via the `ANDROID_KEYSTORE`/`ANDROID_KEYSTORE_PASS_FILE` env vars (see `release.sh`, kept for manual/local releases if ever needed)
- Alias: `nia-todo-android-release`

The release key must stay backed up; changing the key breaks Android over-installs and the Android passkey binding through Digital Asset Links. A signing-key rotation therefore also needs a planned server/docs migration path for `/.well-known/assetlinks.json` and the allowed Android app origin.

Native build notes from `v1.6.0` onward:

- Windows installer includes the local reminder scheduler; reminders work offline as long as app/tray is running.
- Android APK includes the local `AlarmManager` scheduler; reminders work offline and are rescheduled after device reboot.
- Android passkeys require the bundled app ID `de.tobiaskneidl.nia_todo` and the release key; selfhosters connect the bundled app to their server URL.
- Browser/PWA push remains browser/PWA-only; native apps should not depend on the server WebSocket for reminders.
- Service worker remains active even in native wrappers so offline cold start works.

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
- before merge/release, run the focused tests matching the change; the release workflow always runs `./scripts/test_all.sh`
