# Build and debug the Debian desktop app

This guide builds the native Debian desktop client from a source branch and installs the resulting package for a local GNOME/Wayland test.

## Prerequisites

Use Bash for the Node.js toolchain. The project build uses Node.js 22, npm, Python 3, Rust stable, and the Tauri/WebKitGTK development packages.

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl wget file libssl-dev dpkg-dev \
  libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
  libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
```

Install Node.js 22 with the existing nvm setup, then install Rust if it is not already available:

```bash
nvm install 22
nvm use 22
rustup toolchain install stable
rustup default stable
```

## Check out the test branch

```bash
git fetch origin
git switch fix/linux-wayland-global-hotkeys
npm ci
```

## Run the focused checks

```bash
node scripts/test_native_linux_window_integration.mjs
node scripts/test_native_desktop_settings_static.mjs
node scripts/test_native_debian_deb_package_name.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

## Build the Debian package

```bash
python3 scripts/prepare_tauri_frontend_dist.py
npm run tauri -- build --bundles deb

RAW_DEB="$(printf '%s\n' src-tauri/target/release/bundle/deb/nia-todo_*_amd64.deb)"
FINAL_DEB="$(scripts/release/repack-native-debian-deb.sh "$RAW_DEB")"
printf 'Built package: %s\n' "$FINAL_DEB"
```

The repack step is required. It changes the Debian package name to `nia-todo-desktop` and renames the desktop entry to `de.tobiaskneidl.nia-todo.desktop`, matching the application ID used by the XDG Desktop Portal.

## Install and test

```bash
sudo apt install "$FINAL_DEB"
```

Quit every running nia-todo desktop process before starting the installed build. Launch it from a terminal during the first test so portal diagnostics remain visible:

```bash
nia-todo-desktop 2>&1 | tee "$HOME/nia-todo-hotkeys.log"
```

Test all three actions:

1. Put another application in front of nia-todo, then press the show/hide shortcut. nia-todo should move to the foreground.
2. Press the same shortcut while nia-todo is focused. The window should hide.
3. Press the new-todo shortcut while nia-todo is hidden and while it is already focused. The Todo dialog should open with the title field focused.
4. Press the search shortcut while nia-todo is hidden and while it is already focused. Search should open and receive keyboard focus.

The terminal should include a line such as:

```text
[linux-hotkeys] GlobalShortcuts portal version 2
```

Version 1 can deliver shortcut actions but does not provide compositor activation tokens. Reliable foreground activation on GNOME/Wayland therefore requires portal version 2.

## Portal diagnostics

Inspect the active portal implementation and its GlobalShortcuts interface:

```bash
busctl --user introspect \
  org.freedesktop.portal.Desktop \
  /org/freedesktop/portal/desktop \
  org.freedesktop.portal.GlobalShortcuts
```

Follow portal logs while changing or pressing a shortcut:

```bash
journalctl --user -f \
  -u xdg-desktop-portal.service \
  -u xdg-desktop-portal-gnome.service
```

When reporting a failed test, include:

- whether the action fired at all;
- whether nia-todo was hidden, behind another window, or focused;
- the `[linux-hotkeys]` lines from the terminal;
- the GlobalShortcuts portal version from `busctl`;
- the relevant portal journal lines without unrelated private application output.
