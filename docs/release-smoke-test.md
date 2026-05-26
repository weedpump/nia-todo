# Release smoke test

Use this after `./release.sh X.Y.Z` finished and before making a GitHub release public.

Replace `X.Y.Z` with the release version.

## 1. Check generated files

```bash
VERSION=X.Y.Z
TAG="v${VERSION}"
ARTIFACT_DIR="dist/release/${TAG}"
SOURCE_DIR="dist/build/public-release-${TAG}/public-source"

sha256sum -c "${ARTIFACT_DIR}/nia-todo-server-v${VERSION}-full.deb.sha256"
python3 -m json.tool "${ARTIFACT_DIR}/release-manifest.json" >/dev/null

test -d "${SOURCE_DIR}"
test -f "${SOURCE_DIR}/README.md"
test -f "${SOURCE_DIR}/web/static/icons/icon-512.png"
```

## 2. Check Docker image locally

```bash
VERSION=X.Y.Z
NAME="nia-todo-smoke-${VERSION}"
PORT=18753

docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" -p "${PORT}:8753" "nia-todo:${VERSION}"

for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/api/setup/status" && break
  sleep 1
done

curl -fsS "http://127.0.0.1:${PORT}/downloads/app-downloads.json" | python3 -m json.tool
curl -fsSI "http://127.0.0.1:${PORT}/downloads/nia-todo-v${VERSION}-windows-x64-setup.exe"
curl -fsSI "http://127.0.0.1:${PORT}/downloads/nia-todo-v${VERSION}-android-arm64.apk"

docker rm -f "${NAME}"
```

Expected setup status for a fresh instance:

```json
{"setup_complete":false,"has_users":false}
```

## 3. Check Debian package contents

```bash
VERSION=X.Y.Z
DEB="dist/release/v${VERSION}/nia-todo-server-v${VERSION}-full.deb"

dpkg-deb --info "${DEB}"
dpkg-deb --contents "${DEB}" | grep '/opt/nia-todo/web/downloads/'
dpkg-deb --contents "${DEB}" | grep '/opt/nia-todo/wheelhouse/' | wc -l
```

Expected:

- Windows installer is present
- Android APK is present
- `app-downloads.json` is present
- wheelhouse contains Python wheels

## 4. Check install in a disposable Debian/Ubuntu system

```bash
sudo apt install ./nia-todo-server-vX.Y.Z-full.deb
systemctl status nia-todo --no-pager
curl -fsS http://127.0.0.1:8753/api/setup/status
curl -fsS http://127.0.0.1:8753/downloads/app-downloads.json | python3 -m json.tool
sudo test -f /var/lib/nia-todo/nia-todo.db
systemctl status nia-todo-backup.timer --no-pager
sudo nia-todo-backup
ls -1 /var/lib/nia-todo/backups | tail
```

Expected:

- service is active
- setup status is reachable
- downloads manifest lists Windows and Android apps

## 5. Dry-run GitHub publish

```bash
scripts/release/publish-github.sh X.Y.Z \
  --github-repo OWNER/REPO \
  --latest
```

This validates local inputs and prints the push/upload operations. Add `--execute` only when ready to publish.
