"""Client/session metadata helpers."""

from __future__ import annotations

import re

from fastapi import Request

CLIENT_INFO_HEADER = "X-Nia-Client"
_CLIENT_INFO_RE = re.compile(r"^[A-Za-z0-9_.:/=; +,-]{1,120}$")


def _clean_client_info(value: str) -> str:
    value = " ".join(str(value or "").strip().split())[:120]
    if not value or not _CLIENT_INFO_RE.match(value):
        return ""
    return value


def session_user_agent(request: Request) -> str:
    """Return a user-agent string enriched with optional nia-todo client metadata.

    Native apps send X-Nia-Client because their WebView user-agent is otherwise
    indistinguishable from a browser. Put the marker first so DB truncation keeps
    the important app/browser distinction.
    """
    ua = str(request.headers.get("user-agent", "") or "").strip()
    client_info = _clean_client_info(request.headers.get(CLIENT_INFO_HEADER, ""))
    if not client_info:
        return ua
    marker = f"nia-todo-client({client_info})"
    combined = f"{marker} {ua}".strip()
    return combined[:255]
