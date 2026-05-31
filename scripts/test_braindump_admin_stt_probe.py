#!/usr/bin/env python3
"""Regression tests for the BrainDump admin STT connectivity probe."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers import admin  # noqa: E402


class FakeResponse:
    def __init__(self, body: bytes = b'{"text":""}', content_type: str = "application/json"):
        self.body = body
        self.headers = {"content-type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self) -> bytes:
        return self.body


def test_remote_stt_probe_posts_to_exact_configured_url():
    calls: list[tuple[str, str, bytes, dict]] = []
    original_urlopen = admin.urllib.request.urlopen

    def fake_urlopen(req, timeout=0):
        calls.append((req.full_url, req.get_method(), req.data, dict(req.header_items())))
        return FakeResponse()

    admin.urllib.request.urlopen = fake_urlopen
    try:
        ok, message, _sample = admin._probe_remote_stt({
            "stt_url": "http://stt.example.test/custom/transcribe",
            "stt_language": "de",
            "stt_token": "secret-token",
            "stt_timeout_seconds": 42,
        })
    finally:
        admin.urllib.request.urlopen = original_urlopen

    assert ok is True
    assert "processed" in message
    assert calls, "probe must perform an HTTP request"
    url, method, body, headers = calls[0]
    assert url == "http://stt.example.test/custom/transcribe"
    assert method == "POST"
    assert b'Content-Disposition: form-data; name="file"' in body
    assert b'nia-todo-stt-probe.wav' in body
    assert headers.get("Authorization") == "Bearer secret-token"
    assert "multipart/form-data" in headers.get("Content-type", headers.get("Content-Type", ""))


def test_remote_stt_probe_rejects_invalid_json_response():
    original_urlopen = admin.urllib.request.urlopen

    def fake_urlopen(_req, timeout=0):
        return FakeResponse(b'{"not_text":"missing"}', "application/json")

    admin.urllib.request.urlopen = fake_urlopen
    try:
        try:
            admin._probe_remote_stt({"stt_url": "http://stt.example.test/transcribe"})
        except RuntimeError as exc:
            assert "missing text" in str(exc)
        else:
            raise AssertionError("invalid STT JSON response should fail")
    finally:
        admin.urllib.request.urlopen = original_urlopen


def main() -> int:
    test_remote_stt_probe_posts_to_exact_configured_url()
    test_remote_stt_probe_rejects_invalid_json_response()
    print("✅ BrainDump admin STT probe regression tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
