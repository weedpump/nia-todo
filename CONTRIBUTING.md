# Contributing

## Local development

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r packaging/requirements.txt
npm ci
./start.sh
```

Frontend/native development uses the Node/Tauri tooling declared in `package.json` and `src-tauri/`.

Test scripts read `NIA_TODO_DEV_DIR` for their working directory; it defaults to the repo root, so you only need to set it if you run them from elsewhere.

## Branches

- create modular V4 feature branches from `v4` and target `v4`
- create maintenance fixes and dependency updates for the released line from `main` and target `main`
- releases are tagged from `main`

Continue existing feature branches against their intended target; see the [branch workflow](docs/workflow.md).

## Tests

```bash
./scripts/test_all.sh
npm test
```

Focused suites: `npm run test:backend`, `npm run test:frontend`, `npm run test:native`, `npm run test:todo`, `npm run test:ui`. Details: [docs/testing.md](docs/testing.md).

## Release process

See [docs/workflow.md](docs/workflow.md) for the full tag-triggered release flow (`.github/workflows/tests.yml`, `build.yml`, `release.yml`).

## UI changes

Follow the [Design Concept](docs/design-concept.md) for layout, modals, buttons, and reusable patterns.
