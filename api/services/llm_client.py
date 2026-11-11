"""Shared LLM transport and provider adapters; callers own domain prompts.

The connection shape keeps the existing ``llm_*`` configuration contract. A
configured local provider is intentionally allowed; this is not a public-page
downloader. Provider responses and credentials must never become log messages.
"""

from __future__ import annotations

import http.client
import io
import json
import math
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit, urlunsplit

from services.braindump_config import llm_chat_url, parse_extra_headers
from services.http_transport import (
    DeadlineConnection, resolve_addresses, start_deadline_watchdog,
    close_deadline_connection,
)

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def build_headers(config: dict) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    token = str(config.get("llm_api_key") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(parse_extra_headers(str(config.get("llm_extra_headers_json") or "")))
    return headers


def post_chat(payload: dict, headers: dict[str, str], config: dict) -> dict:
    if config.get("_deadline_at") is not None:
        raw = _post_with_deadline(payload, headers, config)
    else:
        # Keep the legacy BrainDump transport/probe injection seam intact.
        request = urllib.request.Request(
            llm_chat_url(config), data=json.dumps(payload).encode("utf-8"),
            headers=headers, method="POST",
        )
        with urllib.request.urlopen(request, timeout=float(config.get("llm_timeout_seconds") or 180)) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("LLM response exceeds the response limit")
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("LLM response must be a JSON object")
    return parsed


def _post_with_deadline(payload: dict, headers: dict[str, str], config: dict) -> bytes:
    """Bound a provider request, including DNS, connect, headers and body.

    Unlike public recipe URLs, explicitly configured providers may use local
    addresses and custom ports. Redirects are not followed: bearer credentials
    must not migrate to a different endpoint or gain a new timeout budget.
    """
    deadline = float(config["_deadline_at"])
    if not math.isfinite(deadline) or time.monotonic() >= deadline:
        raise TimeoutError("LLM deadline exceeded")
    url = llm_chat_url(config)
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None:
        raise ValueError("Invalid configured LLM endpoint")
    tls = parts.scheme == "https"
    host = parts.hostname.encode("idna").decode("ascii")
    port = parts.port if parts.port is not None else (443 if tls else 80)
    if not 1 <= port <= 65535:
        raise ValueError("Invalid configured LLM endpoint")
    addresses = resolve_addresses(host, port, deadline - time.monotonic())
    addresses = sorted((entry for entry in addresses if entry[0] in {socket.AF_INET, socket.AF_INET6}), key=lambda entry: entry[0] != socket.AF_INET)
    if not addresses:
        raise OSError("LLM endpoint has no usable address")
    authority = f"[{host}]" if ":" in host else host
    if port != (443 if tls else 80):
        authority += f":{port}"
    outgoing = dict(headers)
    if not any(key.lower() == "host" for key in outgoing):
        outgoing["Host"] = authority
    outgoing["Accept-Encoding"] = "identity"
    outgoing["Connection"] = "close"
    path = urlunsplit(("", "", quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(parts.query, safe="%/:@!$&'()*+,;=?-._~"), ""))
    body = json.dumps(payload).encode("utf-8")
    for index, (family, address) in enumerate(addresses):
        if time.monotonic() >= deadline:
            raise TimeoutError("LLM deadline exceeded")
        connection = DeadlineConnection(host, port, family, address, tls=tls, deadline=deadline)
        watchdog = start_deadline_watchdog(connection, deadline)
        response = None
        try:
            try:
                # Address fallback is allowed only before a request body was
                # dispatched; never repeat a potentially accepted completion.
                connection.connect()
            except OSError:
                if index + 1 < len(addresses) and time.monotonic() < deadline:
                    continue
                raise
            connection.request("POST", path, body=body, headers=outgoing)
            response = connection.getresponse()
            if time.monotonic() >= deadline:
                raise TimeoutError("LLM deadline exceeded")
            if not 200 <= response.status < 300:
                failure = urllib.error.HTTPError(url, response.status, "LLM request failed", response.headers, io.BytesIO())
                failure.close()
                raise failure
            if response.getheader("Content-Encoding", "identity").strip().lower() not in {"", "identity"}:
                raise ValueError("Unsupported LLM response encoding")
            length = response.getheader("Content-Length")
            if length is not None and (int(length) < 0 or int(length) > MAX_RESPONSE_BYTES):
                raise ValueError("LLM response exceeds the response limit")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if time.monotonic() >= deadline:
                raise TimeoutError("LLM deadline exceeded")
            return raw
        except (OSError, http.client.HTTPException):
            if time.monotonic() >= deadline:
                raise TimeoutError("LLM deadline exceeded") from None
            raise
        finally:
            if response is not None:
                response.close()
            close_deadline_connection(connection, watchdog)
    raise OSError("LLM endpoint connection failed")


def request_payload(payload: dict, config: dict) -> dict:
    provider = str(config.get("llm_provider") or "openai_compatible").strip().lower()
    if provider != "ollama":
        return payload
    options = {"temperature": payload.get("temperature", 0)}
    if payload.get("max_tokens"):
        options["num_predict"] = payload["max_tokens"]
    result = {"model": payload["model"], "messages": payload["messages"], "stream": False, "options": options}
    response_format = payload.get("response_format") or {}
    if isinstance(response_format, dict):
        if response_format.get("type") == "json_object":
            result["format"] = "json"
        elif response_format.get("type") == "json_schema":
            schema = response_format.get("json_schema", {}).get("schema")
            if isinstance(schema, dict):
                result["format"] = schema
    return result


def response_content(result: dict, config: dict) -> str:
    if str(config.get("llm_provider") or "openai_compatible").strip().lower() == "ollama":
        return str(result.get("message", {}).get("content") or "")
    return result["choices"][0]["message"].get("content", "")


def finish_reason(result: dict, config: dict) -> str | None:
    if str(config.get("llm_provider") or "openai_compatible").strip().lower() == "ollama":
        reason = result.get("done_reason") or result.get("message", {}).get("done_reason")
    else:
        choices = result.get("choices") or []
        reason = choices[0].get("finish_reason") if choices else None
    return str(reason) if reason else None


def usage(result: dict, config: dict) -> dict | None:
    if str(config.get("llm_provider") or "openai_compatible").strip().lower() == "ollama":
        values = {"prompt_tokens": result.get("prompt_eval_count"), "completion_tokens": result.get("eval_count")}
        return {key: value for key, value in values.items() if value is not None} or None
    values = result.get("usage")
    return values if isinstance(values, dict) else None


def reasoning_tokens(values: dict | None) -> int | None:
    if not values:
        return None
    details = values.get("completion_tokens_details")
    if not isinstance(details, dict):
        return None
    value = details.get("reasoning_tokens")
    return int(value) if isinstance(value, int) else None


def should_retry_empty(result: dict, config: dict) -> bool:
    return (finish_reason(result, config) or "").lower() in {"length", "max_tokens"} or (reasoning_tokens(usage(result, config)) or 0) > 0
