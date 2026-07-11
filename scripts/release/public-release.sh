#!/bin/bash
# Orchestrate the public nia-todo release artifacts from local builds.
# This does not touch the private deploy flow and does not modify app source.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/public-release.sh VERSION [options]

Builds the public source export plus the release artifacts that are published
outside the private development repo.

Options:
  --windows-installer FILE   Signed Windows installer to embed in both release targets
  --android-apk FILE         Signed Android APK to embed in both release targets
  --linux-deb FILE           Linux Debian package to embed in both release targets
  --native-artifacts-dir DIR Directory containing the standard native artifact names
                           (default: dist/native/vNATIVE_APP_VERSION if it exists)
  --native-app-version VERSION
                           Native app download version to publish (default: VERSION)
  --output-dir DIR           Release artifact output dir (default: dist/release)
  --work-dir DIR             Temporary build dir (default: dist/build/public-release-VERSION)
  --docker-tag TAG           Docker image tag (default: nia-todo:VERSION)
  --docker-latest            Also tag Docker image as nia-todo:latest
  --skip-docker              Do not build Docker image
  --allow-missing-apps       Allow test bundle without Windows/Android/Debian app files
  --init-public-git          Initialize exported public source as fresh git repo/tag
  --force                    Remove existing work/output staging dirs where needed
  --dry-run                  Validate inputs and print planned commands only
USAGE
}

VERSION=""
WINDOWS_INSTALLER=""
ANDROID_APK=""
LINUX_DEB=""
NATIVE_ARTIFACTS_DIR=""
NATIVE_APP_VERSION=""
OUTPUT_DIR="dist/release"
WORK_DIR=""
DOCKER_TAG=""
DOCKER_LATEST=0
SKIP_DOCKER=0
ALLOW_MISSING_APPS=0
INIT_PUBLIC_GIT=0
FORCE=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --windows-installer) WINDOWS_INSTALLER="${2:-}"; shift 2 ;;
    --android-apk) ANDROID_APK="${2:-}"; shift 2 ;;
    --linux-deb) LINUX_DEB="${2:-}"; shift 2 ;;
    --native-artifacts-dir) NATIVE_ARTIFACTS_DIR="${2:-}"; shift 2 ;;
    --native-app-version) NATIVE_APP_VERSION="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --docker-tag) DOCKER_TAG="${2:-}"; shift 2 ;;
    --docker-latest) DOCKER_LATEST=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --allow-missing-apps) ALLOW_MISSING_APPS=1; shift ;;
    --init-public-git) INIT_PUBLIC_GIT=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "${VERSION}" ] || { echo "Multiple versions supplied" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

[ -n "${VERSION}" ] || { usage; exit 2; }
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable version: ${VERSION}" >&2
  exit 2
fi
NATIVE_APP_VERSION="${NATIVE_APP_VERSION:-${VERSION}}"
if ! [[ "${NATIVE_APP_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable native app version: ${NATIVE_APP_VERSION}" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

WORK_DIR="${WORK_DIR:-dist/build/public-release-${VERSION}}"
PUBLIC_EXPORT_DIR="${WORK_DIR}/public-source"
DOCKER_CONTEXT_DIR="${WORK_DIR}/docker-context"
DOCKER_TAG="${DOCKER_TAG:-nia-todo:${VERSION}}"

TAG="v${VERSION}"
NATIVE_TAG="v${NATIVE_APP_VERSION}"
if [ -z "${NATIVE_ARTIFACTS_DIR}" ] && [ -d "dist/native/${NATIVE_TAG}" ]; then
  NATIVE_ARTIFACTS_DIR="dist/native/${NATIVE_TAG}"
fi
if [ -n "${NATIVE_ARTIFACTS_DIR}" ]; then
  [ -n "${WINDOWS_INSTALLER}" ] || WINDOWS_INSTALLER="${NATIVE_ARTIFACTS_DIR}/nia-todo-${NATIVE_TAG}-windows-x64-setup.exe"
  [ -n "${ANDROID_APK}" ] || ANDROID_APK="${NATIVE_ARTIFACTS_DIR}/nia-todo-${NATIVE_TAG}-android-arm64.apk"
  [ -n "${LINUX_DEB}" ] || LINUX_DEB="${NATIVE_ARTIFACTS_DIR}/nia-todo-desktop-${NATIVE_TAG}-linux-amd64.deb"
fi

if [ "${ALLOW_MISSING_APPS}" != "1" ]; then
  [ -n "${WINDOWS_INSTALLER}" ] && [ -f "${WINDOWS_INSTALLER}" ] || { echo "Missing native Windows installer. Build/copy it to dist/native/${NATIVE_TAG}/ or pass --windows-installer FILE" >&2; exit 1; }
  [ -n "${ANDROID_APK}" ] && [ -f "${ANDROID_APK}" ] || { echo "Missing native Android APK. Build/copy it to dist/native/${NATIVE_TAG}/ or pass --android-apk FILE" >&2; exit 1; }
  [ -n "${LINUX_DEB}" ] && [ -f "${LINUX_DEB}" ] || { echo "Missing native Linux Debian package. Build/copy it to dist/native/${NATIVE_TAG}/ or pass --linux-deb FILE" >&2; exit 1; }
fi

run() {
  echo "+ $*"
  if [ "${DRY_RUN}" != "1" ]; then
    "$@"
  fi
}

EXPORT_ARGS=("${VERSION}" --output "${PUBLIC_EXPORT_DIR}")
BUNDLE_ARGS=("${VERSION}" --output-dir "${OUTPUT_DIR}" --work-dir "${WORK_DIR}/full-bundle" --native-app-version "${NATIVE_APP_VERSION}")
DOCKER_ARGS=("${VERSION}" --tag "${DOCKER_TAG}" --output "${DOCKER_CONTEXT_DIR}" --native-app-version "${NATIVE_APP_VERSION}")

if [ "${FORCE}" = "1" ]; then
  EXPORT_ARGS+=(--force)
  BUNDLE_ARGS+=(--force)
  DOCKER_ARGS+=(--force)
fi
if [ "${INIT_PUBLIC_GIT}" = "1" ]; then
  EXPORT_ARGS+=(--init-git)
fi
if [ "${ALLOW_MISSING_APPS}" = "1" ]; then
  BUNDLE_ARGS+=(--allow-missing-apps)
fi
if [ -n "${WINDOWS_INSTALLER}" ]; then
  BUNDLE_ARGS+=(--windows-installer "${WINDOWS_INSTALLER}")
  DOCKER_ARGS+=(--windows-installer "${WINDOWS_INSTALLER}")
fi
if [ -n "${ANDROID_APK}" ]; then
  BUNDLE_ARGS+=(--android-apk "${ANDROID_APK}")
  DOCKER_ARGS+=(--android-apk "${ANDROID_APK}")
fi
if [ -n "${LINUX_DEB}" ]; then
  BUNDLE_ARGS+=(--linux-deb "${LINUX_DEB}")
  DOCKER_ARGS+=(--linux-deb "${LINUX_DEB}")
fi
if [ "${ALLOW_MISSING_APPS}" = "1" ]; then
  DOCKER_ARGS+=(--allow-missing-apps)
fi
if [ "${DOCKER_LATEST}" = "1" ]; then
  DOCKER_ARGS+=(--latest)
fi

run scripts/release/export-public.sh "${EXPORT_ARGS[@]}"
run scripts/release/build-full-bundle.sh "${BUNDLE_ARGS[@]}"
if [ "${SKIP_DOCKER}" != "1" ]; then
  run scripts/release/build-docker.sh "${DOCKER_ARGS[@]}"
else
  echo "↷ Docker build skipped"
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "✅ Dry run complete"
else
  mkdir -p "${OUTPUT_DIR}"
  python3 - "${VERSION}" "${OUTPUT_DIR}" "${PUBLIC_EXPORT_DIR}" "${DOCKER_TAG}" "${NATIVE_APP_VERSION}" "${WINDOWS_INSTALLER}" "${ANDROID_APK}" "${LINUX_DEB}" <<'PYM'
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

version, output_dir, source_dir, docker_tag, native_app_version, windows_path, android_path, linux_path = sys.argv[1:]
out = Path(output_dir)
deb = out / f"nia-todo-server-v{version}-full.deb"
manifest = {
    "version": f"v{version}",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "public_source": {"tag": f"v{version}"},
    "docker_image": docker_tag,
    "native_app_version": f"v{native_app_version}",
    "artifacts": [],
}
for path in [deb, Path(str(deb) + ".sha256"), Path(windows_path) if windows_path else None, Path(android_path) if android_path else None, Path(linux_path) if linux_path else None]:
    if not path or not path.exists():
        continue
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    manifest["artifacts"].append({"name": path.name, "size_bytes": path.stat().st_size, "sha256": h.hexdigest()})
try:
    image_id = subprocess.check_output(["docker", "image", "inspect", docker_tag, "--format", "{{.Id}}"], text=True).strip()
    if image_id:
        manifest["docker_image_id"] = image_id
except Exception:
    pass
(out / "release-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PYM
  echo "✅ Release manifest: ${OUTPUT_DIR}/release-manifest.json"
  echo "✅ Public release artifacts prepared in ${OUTPUT_DIR}"
fi
