"""Generic, DB-backed instance configuration."""

import ipaddress
import json
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException, Request

from db import get_db

DEFAULT_ALLOWED_ORIGINS: list[str] = []
DEFAULT_TRUSTED_PROXIES: list[str] = []

DEFAULT_INSTANCE_CONFIG = {
    "public_base_url": "",
    "allowed_origins": DEFAULT_ALLOWED_ORIGINS,
    "trusted_proxies": DEFAULT_TRUSTED_PROXIES,
}


def _canonical_netloc(parsed) -> str:
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError("missing host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid port") from exc
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    default_port = (parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)
    if port is None or default_port:
        return hostname
    return f"{hostname}:{port}"


def _normalize_http_url(value: str, *, field: str, allow_empty: bool = False, origin_only: bool = False) -> str:
    raw = str(value or "").strip()
    if not raw:
        if allow_empty:
            return ""
        raise HTTPException(400, f"{field} ist erforderlich")

    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(400, f"{field} muss eine gültige http(s)-URL sein")
    if parsed.username or parsed.password:
        raise HTTPException(400, f"{field} darf keine Zugangsdaten enthalten")
    if parsed.query or parsed.fragment:
        raise HTTPException(400, f"{field} darf keinen Query-String oder Fragment enthalten")
    if origin_only and parsed.path not in {"", "/"}:
        raise HTTPException(400, f"{field} darf nur Scheme, Host und optional Port enthalten")
    try:
        netloc = _canonical_netloc(parsed)
    except ValueError:
        raise HTTPException(400, f"{field} enthält einen ungültigen Host oder Port")

    path = "" if origin_only else parsed.path.rstrip("/")
    return urlunparse((parsed.scheme.lower(), netloc, path, "", "", "")).rstrip("/")


def _normalize_forwarded_host(value: str) -> Optional[str]:
    host = str(value or "").split(",")[0].strip()
    if not host:
        return None
    parsed = urlparse(f"http://{host}")
    if parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return None
    try:
        return _canonical_netloc(parsed)
    except ValueError:
        return None


def normalize_public_base_url(value: str) -> str:
    return _normalize_http_url(value, field="Öffentliche Basis-URL", allow_empty=True)


def normalize_allowed_origins(value: Any) -> list[str]:
    if isinstance(value, str):
        origins = [line.strip() for line in value.replace(",", "\n").splitlines()]
    elif isinstance(value, list):
        origins = [str(item).strip() for item in value]
    else:
        raise HTTPException(400, "Allowed Origins müssen eine Liste sein")

    normalized: list[str] = []
    seen = set()
    for origin in origins:
        if not origin:
            continue
        item = _normalize_http_url(origin, field="Allowed Origin", origin_only=True)
        if item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def normalize_trusted_proxies(value: Any) -> list[str]:
    if isinstance(value, str):
        entries = [line.strip() for line in value.replace(",", "\n").splitlines()]
    elif isinstance(value, list):
        entries = [str(item).strip() for item in value]
    else:
        raise HTTPException(400, "Trusted Proxies müssen eine Liste sein")

    normalized: list[str] = []
    seen = set()
    for entry in entries:
        if not entry:
            continue
        try:
            item = str(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            raise HTTPException(400, f"Ungültiger Trusted Proxy: {entry}")
        if item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def _safe_parse_config_value(key: str, value: Optional[str]) -> Any:
    try:
        return _parse_config_value(key, value)
    except HTTPException:
        return DEFAULT_INSTANCE_CONFIG[key]


def _parse_config_value(key: str, value: Optional[str]) -> Any:
    if value is None:
        return DEFAULT_INSTANCE_CONFIG[key]
    if key in {"allowed_origins", "trusted_proxies"}:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return DEFAULT_INSTANCE_CONFIG[key]
        if key == "allowed_origins":
            return normalize_allowed_origins(parsed)
        return normalize_trusted_proxies(parsed)
    if key == "public_base_url":
        return normalize_public_base_url(value)
    return value


def get_instance_config() -> dict[str, Any]:
    values = DEFAULT_INSTANCE_CONFIG.copy()
    try:
        with get_db() as db:
            rows = db.execute(
                "SELECT key, value FROM app_config WHERE key IN ('public_base_url', 'allowed_origins', 'trusted_proxies')"
            ).fetchall()
    except Exception:
        return values

    for row in rows:
        key = row["key"]
        values[key] = _safe_parse_config_value(key, row["value"])
    return values


def update_instance_config(*, public_base_url: str, allowed_origins: Any, trusted_proxies: Any, client_ip: Optional[str] = None) -> dict[str, Any]:
    normalized = {
        "public_base_url": normalize_public_base_url(public_base_url),
        "allowed_origins": normalize_allowed_origins(allowed_origins),
        "trusted_proxies": normalize_trusted_proxies(trusted_proxies),
    }
    serialized = {
        "public_base_url": normalized["public_base_url"],
        "allowed_origins": json.dumps(normalized["allowed_origins"], separators=(",", ":")),
        "trusted_proxies": json.dumps(normalized["trusted_proxies"], separators=(",", ":")),
    }
    with get_db() as db:
        old_rows = db.execute(
            "SELECT key, value FROM app_config WHERE key IN ('public_base_url', 'allowed_origins', 'trusted_proxies')"
        ).fetchall()
        old_values = {row["key"]: row["value"] for row in old_rows}
        changed_keys = [key for key, value in serialized.items() if old_values.get(key) != value]
        for key, value in serialized.items():
            db.execute(
                """INSERT INTO app_config (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
                (key, value),
            )
        if changed_keys:
            db.execute(
                "INSERT INTO app_config_audit (changed_keys, client_ip) VALUES (?, ?)",
                (json.dumps(changed_keys, separators=(",", ":")), client_ip),
            )
        db.commit()
    return normalized


def set_trusted_proxies(trusted_proxies: Any) -> list[str]:
    normalized = normalize_trusted_proxies(trusted_proxies)
    serialized = json.dumps(normalized, separators=(",", ":"))
    with get_db() as db:
        db.execute(
            """INSERT INTO app_config (key, value, updated_at)
               VALUES ('trusted_proxies', ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')""",
            (serialized,),
        )
        db.commit()
    return normalized


def get_allowed_origins() -> list[str]:
    return get_instance_config()["allowed_origins"]


def get_trusted_proxies() -> list[str]:
    return get_instance_config()["trusted_proxies"]


def is_trusted_proxy(client_host: Optional[str]) -> bool:
    if not client_host:
        return False
    try:
        client_ip = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    for proxy in get_trusted_proxies():
        try:
            if client_ip in ipaddress.ip_network(proxy, strict=False):
                return True
        except ValueError:
            continue
    return False


def forwarded_client_ip(client_host: Optional[str], forwarded: Optional[str]) -> Optional[str]:
    if not forwarded or not is_trusted_proxy(client_host):
        return None
    chain = [item.strip() for item in forwarded.split(",") if item.strip()]
    if not chain:
        return None
    try:
        parsed_chain = [ipaddress.ip_address(item) for item in chain]
    except ValueError:
        return None
    for candidate in reversed(parsed_chain):
        if not is_trusted_proxy(str(candidate)):
            return str(candidate)
    return str(parsed_chain[0])


def get_forwarded_client_ip(request: Request) -> Optional[str]:
    client_host = request.client.host if request.client else None
    return forwarded_client_ip(client_host, request.headers.get("X-Forwarded-For"))


def _request_origin(request: Request) -> str:
    scheme = request.url.scheme
    raw_host = request.headers.get("host") or request.url.netloc
    host = _normalize_forwarded_host(raw_host) or raw_host.lower()
    client_host = request.client.host if request.client else None
    if is_trusted_proxy(client_host):
        forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        forwarded_host = _normalize_forwarded_host(request.headers.get("X-Forwarded-Host") or "")
        if forwarded_proto in {"http", "https"}:
            scheme = forwarded_proto
        if forwarded_host:
            host = forwarded_host
    return _normalize_http_url(f"{scheme}://{host}", field="Request-Origin", origin_only=True).lower()


def is_same_request_origin(request: Request, origin: str) -> bool:
    try:
        normalized_origin = _normalize_http_url(origin, field="Origin", origin_only=True).lower()
        request_origin = _request_origin(request)
    except HTTPException:
        return False
    return normalized_origin == request_origin


def get_public_base_url(request: Request) -> str:
    configured = get_instance_config()["public_base_url"]
    if configured:
        return configured
    return _request_origin(request)
