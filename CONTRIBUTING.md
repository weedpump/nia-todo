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

Nia has three modules: Tasks, Shopping, and Recipes. Module registration and shell contributions live in `web/static/js/modules/`; reusable controllers, editors, and synchronization behavior live in `web/static/js/features/`. Put shared behavior in a common primitive or service instead of copying it between modules. See [Architecture](docs/architecture.md), the [Design Concept](docs/design-concept.md), and [AGENTS.md](AGENTS.md) for the module, sharing, and UI contracts.

Test scripts read `NIA_TODO_DEV_DIR` for their working directory; it defaults to the repo root, so you only need to set it if you run them from elsewhere.

## Branches

- create feature branches, maintenance fixes and dependency updates from `main` and target `main`
- releases are tagged from `main`

Continue existing feature branches against their intended target; see the [branch workflow](docs/workflow.md).

## Tests

Read [the test safety policy](docs/testing.md#policy) before running integration or browser suites. They may stop a configured service and replace its database. Use a disposable service and data directory, confirm the actual service/database targets, and establish a verified backup/restore plan. A separate checkout alone is not isolation. Never point tests at production, and keep database-mutating suites serial.

Inside that isolated environment, either command runs the full serial release gate:

```bash
./scripts/test_all.sh
npm test
```

Focused suites: `npm run test:backend`, `npm run test:frontend`, `npm run test:native`, `npm run test:todo`, `npm run test:ui`. Details: [docs/testing.md](docs/testing.md).

## Release process

See [docs/workflow.md](docs/workflow.md) for the full tag-triggered release flow (`.github/workflows/tests.yml`, `build.yml`, `release.yml`).

## UI changes

Follow the [Design Concept](docs/design-concept.md) for layout, modals, buttons, and reusable patterns.

Check desktop and mobile behavior, keyboard and touch interactions, and all twelve supported locales. Reuse shared translation keys for identical concepts. Keep the visible product name **Nia**, while preserving technical identifiers such as `nia-todo`, `NIA_TODO_*`, existing URLs, package names, and native app IDs unless a coordinated migration is explicitly intended.
