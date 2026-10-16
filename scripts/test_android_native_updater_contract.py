#!/usr/bin/env python3

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = (ROOT / "src-tauri/gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
MAIN_ACTIVITY = (ROOT / "src-tauri/gen/android/app/src/main/java/de/tobiaskneidl/nia_todo/MainActivity.kt").read_text(encoding="utf-8")
FILE_PATHS = (ROOT / "src-tauri/gen/android/app/src/main/res/xml/file_paths.xml").read_text(encoding="utf-8")
EMBED = (ROOT / "scripts/release/embed-native-downloads.py").read_text(encoding="utf-8")
PACKAGE = (ROOT / "package.json").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")

required_manifest = (
    'android.permission.REQUEST_INSTALL_PACKAGES',
    'androidx.core.content.FileProvider',
)
for fragment in required_manifest:
    assert fragment in MANIFEST, f"Android manifest missing updater requirement: {fragment}"

assert '<cache-path name="native_updates" path="native-updates/" />' in FILE_PATHS, (
    "Android updater must expose only its private cache subdirectory through FileProvider"
)
assert '<external-path name="my_images" path="." />' not in FILE_PATHS, (
    "Android FileProvider must not expose all external storage"
)

required_native_fragments = (
    'WebViewCompat.addWebMessageListener',
    'WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)',
    'isMainFrame',
    'sourceOrigin',
    '"NiaAndroidUpdater"',
    'private fun updateInstallPermissionState(): String',
    'private fun openUpdateInstallPermissionSettings(): Boolean',
    'private fun startAndroidUpdate(',
    'requestId: String,',
    'expectedSha256: String,',
    'expectedSize: Long,',
    'expectedVersion: String,',
    'Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES',
    'packageManager.canRequestPackageInstalls()',
    'instanceFollowRedirects = false',
    'maxAndroidUpdateDurationMs',
    'SystemClock.elapsedRealtime() - downloadStartedAt',
    'cancelAndroidUpdate(',
    'MessageDigest.getInstance("SHA-256")',
    'PackageManager.GET_SIGNING_CERTIFICATES',
    'PackageInfoCompat.getLongVersionCode',
    'application/vnd.android.package-archive',
    'Intent.FLAG_GRANT_READ_URI_PERMISSION',
    'FileProvider.getUriForFile',
    '__niaAndroidUpdateProgress',
    '__niaAndroidUpdateComplete',
    'pendingAndroidInstallerRequestId',
    'androidInstallerWasPaused',
    'handleReturnedAndroidInstaller()',
    'configuredServerOrigin',
    'uri.rawPath != "/downloads/$filename"',
)
for fragment in required_native_fragments:
    assert fragment in MAIN_ACTIVITY, f"Android native updater contract missing: {fragment}"

assert '@JavascriptInterface\n    fun updateInstallPermissionState' not in MAIN_ACTIVITY
assert '@JavascriptInterface\n    fun openUpdateInstallPermissionSettings' not in MAIN_ACTIVITY
assert '@JavascriptInterface\n    fun installUpdate' not in MAIN_ACTIVITY
assert 'startActivity(installIntent)\n        completeAndroidUpdate(requestId, true' not in MAIN_ACTIVITY, (
    "opening the Android installer must not be reported as a completed update"
)

assert '"android_updater": True' in EMBED, "release manifest must mark fresh Android APKs as native-updater capable"
assert 'apksigner\" verify --verbose' in WORKFLOW, "CI must verify the final signed Android APK"
assert 'test_frontend_android_native_update.mjs' in PACKAGE, "Android updater frontend regression must be in the native suite"
assert 'test_android_native_updater_contract.py' in PACKAGE, "Android updater native contract must be in the native suite"

print("✅ Android native updater contract passed")
