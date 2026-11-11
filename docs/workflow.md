# Workflow

## Development

- work in your local dev checkout; scripts read the path from `NIA_TODO_DEV_DIR` (defaults to the repo root)
- do not expect or modify live data on this host; production runs on a separate LXC
- create feature, fix and dependency branches from `main` and target `main`
- continue existing feature branches against their intended target

## Branches

- `main` -> current released product line, its maintenance updates, releases, and tags
- `codex/<change>` -> short-lived feature or fix branch created from and targeting `main`; remove merged feature branches after integration when requested

The V4 integration branch is merged into `main` for the 4.0.0 release and retired. Feature integration and releases still require an explicit request.

Documentation and in-app release notes may be prepared on feature branches before
a release. A prepared entry is not evidence that its release is available from
`releases/latest` or an image's `latest` tag. Keep unreleased changes under
`CHANGELOG.md`'s Unreleased section until the release is explicitly prepared;
do not change runtime versions, tags or deployment state just to preview copy.

## In-app What's new

The startup tour is an application feature with its own localized data in
`web/static/content/whats-new.json`; `CHANGELOG.md` remains the separate change
history. Maintain each tour's title, introduction and slides in all supported
locales. The client selects the active language, with English and then German as
fallbacks.

The client first selects a release matching the normalized app version through
`version` or `appVersions`. Otherwise it selects the newest `carryForward` release
whose version is no greater than the app version. Future releases are ineligible,
and selection does not depend on whether a tour has been completed. Thus a
prepared `4.0.0` tour does not appear automatically in the current 3.x app.

Completion is stored locally per account and canonical tour version. The final
`done` action remembers completion; dismissing or navigating back does not. An
already completed applicable tour is not replaced by an older unseen one, and a
newer completed eligible tour suppresses automatic fallback to older content.
Programmatic calls to `open()` or `maybeShowWhatsNew({ force: true })` reopen the
applicable tour; this does not add a separate menu action.

## Workflows

Three files, no duplicated build logic. Test logic is intentionally duplicated between `tests.yml` and `release.yml`, not shared via `workflow_call`: `tests.yml` builds and tests a synthetic `v0.0.0` package for fast PR/push feedback, while `release.yml` downloads and tests the actual versioned release `.deb` built by `build.yml` — they can't share a single job.

- **`tests.yml`**: builds a synthetic test package and runs `scripts/release/install-and-test.sh` against it automatically on pull requests and on every push to `main`. Also runs standalone via manual dispatch.
- **`build.yml`**: the single source of truth for building Windows/Android/Debian-desktop/Docker/the full server `.deb`. Triggered manually for ad-hoc test builds (tick only the packages you want; Docker/server-.deb always embed native apps - freshly built ones if selected, otherwise auto-fetched from the latest published GitHub release) - and reused by `release.yml` with a real version and all five packages enabled.
- **`release.yml`**: tag-triggered. Bumps the version and moves the tag, calls `build.yml` with the real version (which also pushes the Docker image directly to GHCR/Docker Hub), runs `scripts/release/install-and-test.sh` against the built server `.deb`, then creates the GitHub release from it.

## Release

Releases are entirely manual to trigger, then fully automatic:

1. Add a `CHANGELOG.md` section for the version first: `## [VERSION] - YYYY-MM-DD`.
2. Tag `main` and push the tag: `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`.
3. Pushing the tag triggers the release workflow, which:
   - bumps the shared version (web app, service worker, Tauri/Cargo, Android) from the tag name via `scripts/release/prepare-release-version.sh`, commits it on `main`, and **force-moves the tag** onto that commit so the tag always points at the exact code that was built
   - builds Windows, Android, and Debian desktop apps, plus the Docker image and full server `.deb`
   - runs the full test suite against the built server `.deb`
   - publishes the GitHub release (assets + checksums), and pushes images to GHCR + Docker Hub

V4 sets the native compatibility floor to **4.0.0**. Publish matching Windows, Android and Debian clients before upgrading a server that enforces this floor. Ordinary releases preserve the existing minimum; an unchanged floor is not by itself proof of compatibility.

For a later deliberate compatibility change, `scripts/release/prepare-release-version.sh VERSION --set-min-app-version` raises the source floor and fresh-install default together. The tag-triggered workflow does not pass that flag automatically.

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

- Keystore: restored in CI from the `ANDROID_KEYSTORE_BASE64`/`ANDROID_KEYSTORE_PASS` secrets (see `release.yml`/`build.yml`); there is no local/manual fallback anymore
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

- develop password/onboarding/2FA changes on dedicated feature branches
- validate email addresses client-side and server-side
- admins create password setup/reset links instead of setting passwords directly
- password links are single-use and valid for 24 hours
- 2FA changes must consider login MFA, reauth MFA, and sensitive actions separately: trusted devices/login MFA must not authorize any account security action
- recovery codes are only backup factors for TOTP/passkey; changes to them need at least `scripts/test_two_factor_services.py` and a focused security review
- before merge/release, run the focused tests matching the change; the release workflow always runs `./scripts/test_all.sh`
