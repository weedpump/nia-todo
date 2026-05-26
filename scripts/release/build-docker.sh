#!/bin/bash
# Build the nia-todo Docker image from a clean public export.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/build-docker.sh VERSION [options]

Options:
  --tag TAG       Docker tag to build (default: nia-todo:VERSION)
  --latest       Also tag as nia-todo:latest
  --output DIR   Export/build context directory (default: dist/docker/nia-todo-VERSION)
  --force        Remove existing build context first
USAGE
}

VERSION=""
TAG=""
LATEST=0
OUTPUT=""
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "${VERSION}" ] || { echo "Multiple versions supplied" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

[ -n "${VERSION}" ] || { usage; exit 2; }
TAG="${TAG:-nia-todo:${VERSION}}"
OUTPUT="${OUTPUT:-dist/docker/nia-todo-${VERSION}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found; cannot build image on this host" >&2
  exit 127
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

scripts/release/export-public.sh "${VERSION}" --output "${OUTPUT}" ${FORCE:+--force}

rm -rf "${OUTPUT}/wheelhouse"
mkdir -p "${OUTPUT}/wheelhouse"
docker run --rm \
  -v "${OUTPUT}:/work" \
  -w /work \
  python:3.13.5-slim \
  python -m pip wheel --wheel-dir /work/wheelhouse -r /work/requirements.txt

docker build -t "${TAG}" "${OUTPUT}"
if [ "${LATEST}" = "1" ]; then
  docker tag "${TAG}" nia-todo:latest
fi

echo "✅ Docker image built: ${TAG}"
if [ "${LATEST}" = "1" ]; then echo "✅ Also tagged: nia-todo:latest"; fi
