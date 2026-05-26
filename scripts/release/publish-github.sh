#!/bin/bash
# Publish a prepared public nia-todo release to a GitHub repo/release.
# Safe by default: without --execute it only validates and prints commands.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/publish-github.sh VERSION --github-repo OWNER/REPO [options]

Options:
  --github-repo OWNER/REPO  GitHub repo for the public snapshot/releases
  --source-dir DIR          Public source export (default: dist/build/public-release-vVERSION/public-source)
  --artifact-dir DIR        Release artifact dir (default: dist/release/vVERSION)
  --docker-image IMAGE      Local Docker image to publish (default: nia-todo:VERSION)
  --ghcr-image IMAGE        GHCR image name (default: ghcr.io/OWNER/nia-todo)
  --no-source-push          Do not push the public source snapshot/tag
  --no-gh-release           Do not create/upload GitHub release assets
  --no-docker-push          Do not push Docker image to GHCR
  --latest                  Also push GHCR :latest tag
  --git-author-name NAME    Public Git commit/tag author name (default: GitHub account name/login)
  --git-author-email EMAIL  Public Git commit/tag author email (default: GitHub noreply email)
  --execute                 Actually push/upload. Default is dry-run.
  -h, --help                Show this help

Expected inputs are produced by ./release.sh VERSION or scripts/release/public-release.sh.
USAGE
}

VERSION=""
GITHUB_REPO=""
SOURCE_DIR=""
ARTIFACT_DIR=""
DOCKER_IMAGE=""
GHCR_IMAGE=""
PUSH_SOURCE=1
CREATE_RELEASE=1
PUSH_DOCKER=1
LATEST=0
PUBLIC_GIT_AUTHOR_NAME=""
PUBLIC_GIT_AUTHOR_EMAIL=""
PUBLIC_GIT_LOGIN=""
PUBLIC_GIT_ID=""
EXECUTE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --github-repo) GITHUB_REPO="${2:-}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:-}"; shift 2 ;;
    --artifact-dir) ARTIFACT_DIR="${2:-}"; shift 2 ;;
    --docker-image) DOCKER_IMAGE="${2:-}"; shift 2 ;;
    --ghcr-image) GHCR_IMAGE="${2:-}"; shift 2 ;;
    --no-source-push) PUSH_SOURCE=0; shift ;;
    --no-gh-release) CREATE_RELEASE=0; shift ;;
    --no-docker-push) PUSH_DOCKER=0; shift ;;
    --latest) LATEST=1; shift ;;
    --git-author-name) PUBLIC_GIT_AUTHOR_NAME="${2:-}"; shift 2 ;;
    --git-author-email) PUBLIC_GIT_AUTHOR_EMAIL="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "${VERSION}" ] || { echo "Multiple versions supplied" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

[ -n "${VERSION}" ] || { usage; exit 2; }
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid stable version: ${VERSION}" >&2
  exit 2
fi
[ -n "${GITHUB_REPO}" ] || { echo "Missing --github-repo OWNER/REPO" >&2; exit 2; }
if ! [[ "${GITHUB_REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid --github-repo: ${GITHUB_REPO}" >&2
  exit 2
fi

TAG="v${VERSION}"
OWNER="${GITHUB_REPO%%/*}"
SOURCE_DIR="${SOURCE_DIR:-dist/build/public-release-${TAG}/public-source}"
ARTIFACT_DIR="${ARTIFACT_DIR:-dist/release/${TAG}}"
DOCKER_IMAGE="${DOCKER_IMAGE:-nia-todo:${VERSION}}"
GHCR_IMAGE="${GHCR_IMAGE:-ghcr.io/${OWNER}/nia-todo}"
DEB="${ARTIFACT_DIR}/nia-todo-server-v${VERSION}-full.deb"
DEB_SHA="${DEB}.sha256"
RELEASE_MANIFEST="${ARTIFACT_DIR}/release-manifest.json"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

[ -d "${SOURCE_DIR}" ] || { echo "Missing public source dir: ${SOURCE_DIR}" >&2; exit 1; }
[ -f "${DEB}" ] || { echo "Missing Debian bundle: ${DEB}" >&2; exit 1; }
[ -f "${DEB_SHA}" ] || { echo "Missing Debian checksum: ${DEB_SHA}" >&2; exit 1; }
sha256sum -c "${DEB_SHA}"
if [ -f "${RELEASE_MANIFEST}" ]; then
  python3 -m json.tool "${RELEASE_MANIFEST}" >/dev/null
fi

if [ "${PUSH_DOCKER}" = "1" ]; then
  docker image inspect "${DOCKER_IMAGE}" >/dev/null
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 127; }
}
[ "${PUSH_SOURCE}" = "0" ] || need_cmd git
[ "${PUSH_SOURCE}" = "0" ] || need_cmd gh
[ "${PUSH_SOURCE}" = "0" ] || need_cmd rsync
[ "${CREATE_RELEASE}" = "0" ] || need_cmd gh
[ "${PUSH_DOCKER}" = "0" ] || need_cmd docker

run() {
  echo "+ $*"
  if [ "${EXECUTE}" = "1" ]; then
    "$@"
  fi
}

resolve_public_git_identity() {
  local gh_user_json gh_name
  gh_user_json="$(gh api user)"
  PUBLIC_GIT_LOGIN="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("login") or "")' <<<"${gh_user_json}")"
  PUBLIC_GIT_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("id") or "")' <<<"${gh_user_json}")"
  gh_name="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("name") or "")' <<<"${gh_user_json}")"
  PUBLIC_GIT_AUTHOR_NAME="${PUBLIC_GIT_AUTHOR_NAME:-${gh_name:-${PUBLIC_GIT_LOGIN}}}"
  PUBLIC_GIT_AUTHOR_EMAIL="${PUBLIC_GIT_AUTHOR_EMAIL:-${PUBLIC_GIT_ID}+${PUBLIC_GIT_LOGIN}@users.noreply.github.com}"
}

validate_public_git_identity() {
  local expected_email
  expected_email="${PUBLIC_GIT_ID}+${PUBLIC_GIT_LOGIN}@users.noreply.github.com"
  if [[ "${PUBLIC_GIT_AUTHOR_EMAIL}" =~ ^[0-9]+\+${PUBLIC_GIT_LOGIN}@users\.noreply\.github\.com$ ]] && [ "${PUBLIC_GIT_AUTHOR_EMAIL}" != "${expected_email}" ]; then
    echo "GitHub noreply author email does not match authenticated account id." >&2
    echo "Expected: ${expected_email}" >&2
    echo "Got:      ${PUBLIC_GIT_AUTHOR_EMAIL}" >&2
    exit 1
  fi
}

if [ "${EXECUTE}" != "1" ]; then
  echo "ℹ️  Dry-run only. Add --execute to push/upload."
fi

if [ "${PUSH_SOURCE}" = "1" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  if gh repo view "${GITHUB_REPO}" >/dev/null 2>&1; then
    run git clone "https://github.com/${GITHUB_REPO}.git" "${TMP}/repo"
  else
    echo "+ git init ${TMP}/repo  # repo must exist or be created separately"
    mkdir -p "${TMP}/repo"
    if [ "${EXECUTE}" = "1" ]; then git init "${TMP}/repo"; fi
  fi
  if [ "${EXECUTE}" = "1" ]; then
    rsync -a --delete --exclude .git "${SOURCE_DIR}/" "${TMP}/repo/"
    cd "${TMP}/repo"
    resolve_public_git_identity
    validate_public_git_identity
    git config user.name "${PUBLIC_GIT_AUTHOR_NAME}"
    git config user.email "${PUBLIC_GIT_AUTHOR_EMAIL}"
    git checkout -B main
    git add -A
    git commit -m "Release ${TAG}" || echo "No public source changes to commit"
    git tag -a "${TAG}" -m "Release ${TAG}"
    git remote remove origin >/dev/null 2>&1 || true
    git remote add origin "https://github.com/${GITHUB_REPO}.git"
    git push origin main
    git push origin "${TAG}"
    cd "${ROOT_DIR}"
  else
    echo "+ rsync -a --delete --exclude .git ${SOURCE_DIR}/ <public-repo>/"
    echo "+ git commit -m 'Release ${TAG}' && git tag -a ${TAG} -m 'Release ${TAG}'"
    echo "+ git push origin main && git push origin ${TAG}"
  fi
fi

if [ "${CREATE_RELEASE}" = "1" ]; then
  RELEASE_NOTES="${ARTIFACT_DIR}/github-release-notes.md"
  if [ "${EXECUTE}" = "1" ]; then
    cat > "${RELEASE_NOTES}" <<NOTES
nia-todo ${TAG}

Distribution targets:
- Full Debian/Ubuntu server bundle: $(basename "${DEB}")
- Docker image: ${GHCR_IMAGE}:${VERSION}

Windows and Android apps are bundled into the server package/image and served via /downloads/.
NOTES
  else
    echo "+ cat > ${RELEASE_NOTES}"
  fi
  ASSETS=("${DEB}" "${DEB_SHA}")
  [ ! -f "${RELEASE_MANIFEST}" ] || ASSETS+=("${RELEASE_MANIFEST}")
  run gh release create "${TAG}" "${ASSETS[@]}" --repo "${GITHUB_REPO}" --title "nia-todo ${TAG}" --notes-file "${RELEASE_NOTES}"
fi

if [ "${PUSH_DOCKER}" = "1" ]; then
  run docker tag "${DOCKER_IMAGE}" "${GHCR_IMAGE}:${VERSION}"
  run docker push "${GHCR_IMAGE}:${VERSION}"
  if [ "${LATEST}" = "1" ]; then
    run docker tag "${DOCKER_IMAGE}" "${GHCR_IMAGE}:latest"
    run docker push "${GHCR_IMAGE}:latest"
  fi
fi

echo "✅ Publish preparation complete for ${TAG}"
