#!/usr/bin/env python3
"""Regression tests for the ASGI request body limit."""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from middleware.security import RequestBodyLimitMiddleware  # noqa: E402


async def run_middleware(headers, events, maximum):
    app_called = False
    sent = []

    async def app(scope, receive, send):
        nonlocal app_called
        app_called = True
        while True:
            event = await receive()
            if event["type"] == "http.disconnect" or not event.get("more_body"):
                return

    iterator = iter(events)

    async def receive():
        return next(iterator, {"type": "http.disconnect"})

    async def send(message):
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(app, max_body_bytes=maximum)
    await middleware({"type": "http", "headers": headers}, receive, send)
    return app_called, sent


def test_rejects_oversized_content_length_before_calling_app() -> None:
    app_called, sent = asyncio.run(run_middleware(
        [(b"content-length", b"5")],
        [{"type": "http.request", "body": b"12345", "more_body": False}],
        4,
    ))
    assert not app_called
    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 413


def test_rejects_chunked_body_after_limit_is_exceeded() -> None:
    _, sent = asyncio.run(run_middleware(
        [],
        [
            {"type": "http.request", "body": b"123", "more_body": True},
            {"type": "http.request", "body": b"45", "more_body": False},
        ],
        4,
    ))
    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 413


if __name__ == "__main__":
    test_rejects_oversized_content_length_before_calling_app()
    test_rejects_chunked_body_after_limit_is_exceeded()
    print("✅ Request body limit regression tests passed")
