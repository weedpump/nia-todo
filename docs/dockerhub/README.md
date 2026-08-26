<p align="center">
  <img src="https://raw.githubusercontent.com/weedpump/nia-todo/main/web/static/icons/icon-512.png" alt="nia-todo logo" width="96">
</p>

<h1 align="center">nia-todo</h1>

<p align="center">
  <strong>Official Docker image:</strong> <code>docker.io/weedpump/nia-todo</code>
</p>

nia-todo is a self-hosted todo system with SQLite, FastAPI, a polished Web UI, offline-capable PWA support, and bundled native client downloads for Windows, Android, and Debian desktop.

This repository is the official Docker Hub mirror for nia-todo. Other Docker Hub images may be community-maintained forks and are not published or supported by the project maintainer.

## Quick start

Run nia-todo with Docker Compose:

```yaml
services:
  nia-todo:
    image: docker.io/weedpump/nia-todo:latest
    ports:
      - "8753:8753"
    environment:
      NIA_TODO_HOST: auto
      NIA_TODO_PORT: 8753
      NIA_TODO_DATA_DIR: /data
      NIA_TODO_DB: nia-todo.db
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - nia-todo-data:/data

volumes:
  nia-todo-data:
```

Start it:

```bash
docker compose up -d
```

Then open:

```text
http://YOUR-SERVER:8753/setup
```

Create the initial admin account, then use the app at:

```text
http://YOUR-SERVER:8753/
```

## Docker run

```bash
docker run -d \
  --name nia-todo \
  --restart unless-stopped \
  -p 8753:8753 \
  -e NIA_TODO_HOST=auto \
  -e NIA_TODO_PORT=8753 \
  -e NIA_TODO_DATA_DIR=/data \
  -e NIA_TODO_DB=nia-todo.db \
  --read-only \
  --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v nia-todo-data:/data \
  docker.io/weedpump/nia-todo:latest
```

## Tags

- `latest` — latest published stable release
- `X.Y.Z` — pinned release version, recommended for production

Example:

```yaml
image: docker.io/weedpump/nia-todo:3.0.1
```

For production deployments, pin a version instead of relying on `latest`.

## Persistent data

The container stores runtime data in:

```text
/data
```

Keep this volume persistent. It contains the SQLite database, generated keys, avatars, backups, todo attachments, and local runtime data.

## Updates

Docker installations are updated by pulling the new image and recreating the container or Compose stack:

```bash
docker compose pull
docker compose up -d
```

Before major upgrades, create a backup of the persistent data volume.

## Production notes

For production use, put nia-todo behind HTTPS and configure the public base URL in the admin panel. Passkeys and native app integrations rely on the public URL being correct.

Useful paths after setup:

```text
/setup      Initial setup
/admin      Admin panel
/downloads  Bundled native app downloads
```

## Image mirrors

Official images are published to:

```text
docker.io/weedpump/nia-todo
ghcr.io/weedpump/nia-todo
```

Both registries are official release targets for the same project.

## Source, releases, and support

- Source: https://github.com/weedpump/nia-todo
- Releases: https://github.com/weedpump/nia-todo/releases
- Issues: https://github.com/weedpump/nia-todo/issues

## License

nia-todo is free software licensed under the GNU Affero General Public License v3.0 or later.

Copyright (C) 2026 Tobias Kneidl
