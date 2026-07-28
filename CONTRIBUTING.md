# Contributing

## Local development

Set `NIA_TODO_DEV_DIR` to your checkout path (used by test scripts):

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r packaging/requirements.txt
npm ci
./start.sh
```

Frontend/native development uses the Node/Tauri tooling declared in `package.json` and `src-tauri/`.

## Branches

- `develop` -> active development
- `main` -> stable versions / tags

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
