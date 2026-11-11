#!/usr/bin/env python3
"""Offline metadata/patched-file regressions; never writes the Cargo registry."""
import copy
import importlib.util
import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("android_gradle_patch", ROOT / "scripts/patch_tauri_android_gradle.py")
android_patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(android_patch)


class AndroidGradlePatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = self.root / "app/Cargo.toml"
        self.tauri = self.root / "registry/tauri-2.12.5"
        self.metadata = {
            "packages": [
                {"id": "app-id", "name": "nia-todo-desktop", "version": "4.0.0", "manifest_path": str(self.manifest)},
                {"id": "selected-tauri", "name": "tauri", "version": "2.12.5", "manifest_path": str(self.tauri / "Cargo.toml")},
            ],
            "resolve": {"nodes": [{"id": "app-id", "deps": [
                {"name": "tauri", "pkg": "selected-tauri", "dep_kinds": [{"kind": None, "target": None}]},
            ]}]},
        }

    def resolve(self, metadata=None):
        return android_patch.tauri_root_from_metadata(metadata or self.metadata, self.manifest)

    def test_current_locked_version_and_later_patch_upgrades_resolve_without_another_pin(self):
        locked = tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text())
        versions = [p["version"] for p in locked["package"] if p["name"] == "tauri"]
        self.assertEqual(len(versions), 1)
        for version in [versions[0], "2.12.6", "2.13.0"]:
            with self.subTest(version=version):
                self.metadata["packages"][1]["version"] = version
                self.assertEqual(self.resolve(), self.tauri)

    def test_unrelated_tauri_packages_are_not_selected(self):
        self.metadata["packages"].append({"id": "other-tauri", "name": "tauri", "version": "2.12.3", "manifest_path": str(self.root / "other/Cargo.toml")})
        # Even if a virtual workspace has no resolve.root, select by the requested manifest.
        self.metadata["resolve"]["root"] = None
        self.assertEqual(self.resolve(), self.tauri)

    def test_renamed_normal_dependency_is_supported(self):
        self.metadata["resolve"]["nodes"][0]["deps"][0]["name"] = "native_runtime"
        self.assertEqual(self.resolve(), self.tauri)

    def test_missing_or_ambiguous_manifest_fails(self):
        for packages in [self.metadata["packages"][1:], self.metadata["packages"] + [copy.deepcopy(self.metadata["packages"][0])]]:
            metadata = copy.deepcopy(self.metadata)
            metadata["packages"] = packages
            with self.assertRaisesRegex(SystemExit, "exactly one Cargo package"):
                self.resolve(metadata)

    def test_missing_resolved_graph_fails(self):
        self.metadata["resolve"] = None
        with self.assertRaisesRegex(SystemExit, "resolved dependency graph"):
            self.resolve()

    def test_transitive_or_build_only_tauri_is_not_a_runtime_dependency(self):
        for dependencies in [[], [{"name": "tauri", "pkg": "selected-tauri", "dep_kinds": [{"kind": "build"}]}]]:
            self.metadata["resolve"]["nodes"][0]["deps"] = dependencies
            with self.assertRaisesRegex(SystemExit, "direct tauri dependency, found 0"):
                self.resolve()

    def test_two_direct_tauri_versions_fail_instead_of_patching_arbitrarily(self):
        self.metadata["packages"].append({"id": "other-tauri", "name": "tauri", "version": "2.11.0", "manifest_path": str(self.root / "other/Cargo.toml")})
        self.metadata["resolve"]["nodes"][0]["deps"].append({"name": "other", "pkg": "other-tauri", "dep_kinds": [{"kind": None}]})
        with self.assertRaisesRegex(SystemExit, "direct tauri dependency, found 2"):
            self.resolve()

    def test_unsupported_major_and_prerelease_fail(self):
        for version in ["1.8.3", "3.0.0", "2.13.0-beta.1"]:
            self.metadata["packages"][1]["version"] = version
            with self.assertRaisesRegex(SystemExit, "Unsupported Tauri version"):
                self.resolve()

    def test_cargo_metadata_keeps_locked_resolution(self):
        with patch.object(android_patch.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(self.metadata), "")) as run:
            self.assertEqual(android_patch.resolve_tauri_root(self.manifest), self.tauri)
        self.assertEqual(run.call_args.args[0], ["cargo", "metadata", "--manifest-path", str(self.manifest), "--format-version", "1", "--locked"])
        self.assertTrue(run.call_args.kwargs["check"])

    def gradle_file(self, source):
        file = self.tauri / "mobile/android/build.gradle.kts"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source)
        return file

    def test_patch_preserves_source_and_is_idempotent(self):
        source = 'plugins {\n  id("com.android.library")\n}\nandroid { namespace = "app.tauri" }\n'
        file = self.gradle_file(source)
        android_patch.patch_tauri_android_gradle(self.tauri)
        android_patch.patch_tauri_android_gradle(self.tauri)
        self.assertEqual(file.read_text(), android_patch.SUPPRESSION + "\n\n" + source)

    def test_missing_or_unexpected_source_fails_without_writing(self):
        with self.assertRaisesRegex(SystemExit, "Missing Tauri Android Gradle"):
            android_patch.patch_tauri_android_gradle(self.tauri)
        valid = 'plugins { id("com.android.library") }\nandroid { namespace = "app.tauri" }\n'
        for source in ["plugins {}\n", valid.replace('"app.tauri"', '"other.library"'), '@file:Suppress("OTHER")\n' + valid]:
            file = self.gradle_file(source)
            with self.assertRaises(SystemExit):
                android_patch.patch_tauri_android_gradle(self.tauri)
            self.assertEqual(file.read_text(), source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
