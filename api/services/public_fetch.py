"""Bounded public HTTP downloads for untrusted import URLs.

Resolve and validate every redirect, then connect to that exact IP. Host/SNI
remain the original hostname; environment proxies, cookies and auth are unused.
"""
from __future__ import annotations

import concurrent.futures
import http.client
import ipaddress
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

from services.http_transport import (
    DNS_POOL, DNS_SLOTS, DNSBusyError, DeadlineConnection, resolve_addresses,
    start_deadline_watchdog, close_deadline_connection,
)


class PublicFetchError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PublicResponse:
    url: str
    body: bytes
    content_type: str
    charset: str | None = None


# Compatibility seams for existing transport tests; all HTTP clients share
# one bounded resolver and one deadline/socket implementation.
_DNS = DNS_POOL
_DNS_SLOTS = DNS_SLOTS
_PinnedConnection = DeadlineConnection
_MAX_REDIRECTS = 4


def normalize_public_url(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value:
        raise PublicFetchError("recipe.import.invalidUrl")
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError()
        host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if not host or "%" in host or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-.:" for c in host):
            raise ValueError()
        port = parts.port
        if port is not None and port != (443 if parts.scheme.lower() == "https" else 80):
            raise PublicFetchError("recipe.import.blockedUrl")
        authority = f"[{host}]" if ":" in host else host
        # Fragments never participate in a download or persisted provenance.
        return urlunsplit((parts.scheme.lower(), authority, quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(parts.query, safe="%/:@!$&'()*+,;=?-._~"), ""))
    except PublicFetchError:
        raise
    except (ValueError, UnicodeError):
        raise PublicFetchError("recipe.import.invalidUrl") from None


def _public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
        # Mapped/transition forms must not hide an otherwise forbidden target.
        if isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None):
            return False
        if isinstance(ip, ipaddress.IPv6Address) and any(ip in network for network in (
            ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"),
        )):
            return False
        return ip.is_global and not ip.is_multicast and not ip.is_unspecified
    except ValueError:
        return False


def _addresses(host: str, port: int, remaining: float) -> list[tuple[int, str]]:
    try:
        records = resolve_addresses(host, port, remaining, pool=_DNS, slots=_DNS_SLOTS)
    except DNSBusyError:
        raise PublicFetchError("recipe.import.busy") from None
    except OSError:
        raise PublicFetchError("recipe.import.downloadFailed") from None
    if not records or any(family not in {socket.AF_INET, socket.AF_INET6} or not _public_ip(address) for family, address in records):
        raise PublicFetchError("recipe.import.blockedUrl")
    return records


def fetch_public(url: str, *, max_bytes: int = 2 * 1024 * 1024, timeout: float = 15,
                 image: bool = False) -> PublicResponse:
    """Download public HTML or raster image bytes without executing page code."""
    current = normalize_public_url(url)
    deadline = time.monotonic() + timeout
    seen: set[str] = set()
    for _ in range(_MAX_REDIRECTS + 1):
        if current in seen or time.monotonic() >= deadline:
            raise PublicFetchError("recipe.import.downloadFailed")
        seen.add(current)
        parts = urlsplit(current)
        host, tls = parts.hostname, parts.scheme == "https"
        port = 443 if tls else 80
        addresses = _addresses(host, port, deadline - time.monotonic())
        # One pinned address per hop; a retry is a new user action, not an
        # opportunity for attacker-controlled DNS to change the target.
        family, address = min(addresses, key=lambda entry: entry[0] != socket.AF_INET)
        connection = _PinnedConnection(host, port, family, address, tls=tls, deadline=deadline)
        response = None
        watchdog = start_deadline_watchdog(connection, deadline)
        try:
            connection.request("GET", urlunsplit(("", "", parts.path, parts.query, "")), headers={
                "Host": parts.netloc, "User-Agent": "Nia/recipe-import", "Accept-Encoding": "identity",
                "Accept": "image/jpeg,image/png,image/webp" if image else "text/html,application/xhtml+xml",
                "Connection": "close",
            })
            response = connection.getresponse()
            if time.monotonic() >= deadline:
                raise PublicFetchError("recipe.import.downloadFailed")
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise PublicFetchError("recipe.import.downloadFailed")
                current = normalize_public_url(urljoin(current, location))
                continue
            if response.status != 200:
                raise PublicFetchError("recipe.import.downloadFailed")
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            accepted = {"image/jpeg", "image/png", "image/webp"} if image else {"text/html", "application/xhtml+xml"}
            if content_type not in accepted or response.getheader("Content-Encoding", "identity").strip().lower() not in {"", "identity"}:
                raise PublicFetchError("recipe.import.unsupportedContent")
            length = response.getheader("Content-Length")
            if length is not None:
                try:
                    if int(length) > max_bytes or int(length) < 0:
                        raise PublicFetchError("recipe.import.tooLarge")
                except ValueError as error:
                    if isinstance(error, PublicFetchError):
                        raise
                    raise PublicFetchError("recipe.import.downloadFailed") from None
            chunks, size = [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise PublicFetchError("recipe.import.downloadFailed")
                if connection.sock is not None:
                    connection.sock.settimeout(max(.01, deadline - time.monotonic()))
                # read1 performs at most one read, preventing slow trickles from
                # resetting a per-operation timeout indefinitely.
                chunk = response.read1(min(65536, max_bytes + 1 - size))
                if time.monotonic() >= deadline:
                    raise PublicFetchError("recipe.import.downloadFailed")
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > max_bytes:
                    raise PublicFetchError("recipe.import.tooLarge")
            charset = response.headers.get_content_charset()
            return PublicResponse(current, b"".join(chunks), content_type, charset)
        except PublicFetchError:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            raise PublicFetchError("recipe.import.downloadFailed") from None
        finally:
            if response is not None:
                response.close()
            close_deadline_connection(connection, watchdog)
    raise PublicFetchError("recipe.import.downloadFailed")
