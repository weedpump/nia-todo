<p align="center">
  <img src="https://raw.githubusercontent.com/weedpump/nia-todo/main/web/static/icons/icon-512.png" alt="Nia logo" width="96">
</p>

<h1 align="center">Nia</h1>

<p align="center">
  <strong>Official Docker image:</strong> <code>docker.io/weedpump/nia-todo</code>
</p>

Nia is a self-hosted app for organizing everyday life, with SQLite, FastAPI, an offline-capable web app and PWA, and bundled native client downloads for Windows, Android, and Debian desktop.

This repository is the official Docker Hub mirror for Nia. Other Docker Hub images may be community-maintained forks and are not published or supported by the project maintainer.

> **V4 development:** The `v4` source branch adds the modular app described below. V4 has not been released yet. The published stable images, including `latest`, currently provide the 3.x line; these installation commands do not install the unreleased V4 branch.

## Coming in V4

- **Tasks:** projects, sections, personal workspaces, reminders, recurring todos, subtasks, comments, and attachments.
- **Shopping:** personal or shared lists, sections, quantities, units, stores, bulk entry, and offline synchronization.
- **Recipes:** cookbooks, tags and images, ingredients assigned to preparation steps, scaled portions, a cooking view, and ingredient transfer to Shopping.
- **Sharing and households:** share projects, lists, and cookbooks with individual users or place them under household ownership. Choose visible modules per account.
- **Personal routing memory:** editable remembered destinations across manual entry, BrainDump, and recipe transfers, without requiring an AI service for the memory itself.
- **Optional BrainDump:** review mixed Tasks and Shopping suggestions from speech; import recipes from free text or refine a draft with the configured LLM. An administrator must enable BrainDump for the account. Providers can run locally or remotely; voice capture also needs a speech-to-text provider. Supported recipe links can be imported online without BrainDump; review the draft before saving.

The visible product name is **Nia**. The image name `weedpump/nia-todo`, existing environment variables, service names, and persistent data paths remain unchanged for compatibility.

## Quick start

Run Nia with Docker Compose:

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

Read the one-time setup token, then open the setup page:

```bash
docker compose logs nia-todo
```

```text
http://YOUR-SERVER:8753/setup
```

The token is deleted after the first user is created. Create the initial admin account, then use the app at:

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
image: docker.io/weedpump/nia-todo:X.Y.Z
```

Replace `X.Y.Z` with an existing published release tag. For production deployments, pin a version instead of relying on `latest`.

## Persistent data

The container stores runtime data in:

```text
/data
```

Keep this volume persistent. It contains the SQLite database, generated keys, avatars, backups, Todo attachments, and local runtime data. V4 Shopping and Recipe records, including recipe images, are also part of the database and its backups.

## Updates

Docker installations are updated by pulling the new image and recreating the container or Compose stack:

```bash
docker compose pull
docker compose up -d
```

Before major upgrades, create a backup of the persistent data volume.

## Production notes

For production use, put Nia behind HTTPS and configure the public base URL in the admin panel. Passkeys and native app integrations rely on the public URL being correct.

Useful paths after setup:

```text
/setup      Initial setup
/admin      Admin panel
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

Nia is free software licensed under the GNU Affero General Public License v3.0 or later.

Copyright (C) 2026 Tobias Kneidl
