# Vendored Tauri API

- Upstream package: `@tauri-apps/api`
- Upstream version: 2.11.0
- Source: https://www.npmjs.com/package/@tauri-apps/api/v/2.11.0
- License: Apache-2.0 OR MIT

nia-todo serves unbundled ES modules directly, so the small browser-facing subset used by `web/static/js/core/config.js` is vendored here. `scripts/test_tauri_vendor_sync.mjs` compares every vendored source and license file with the package installed by `npm ci`. Updating `@tauri-apps/api` therefore requires refreshing this directory in the same change.
