#!/usr/bin/env python3
"""Start the nia-todo API with robust wildcard binding.

The default auto mode binds every available stack:
- IPv6 wildcard when IPv6 is available
- IPv4 wildcard when needed/available

On Linux systems where an IPv6 wildcard socket also accepts IPv4-mapped
connections, the IPv4 socket is skipped to avoid duplicate port binds.
"""

from __future__ import annotations

import os
import socket
from typing import Iterable

import uvicorn


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _make_socket(family: socket.AddressFamily, host: str, port: int) -> socket.socket | None:
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if family == socket.AF_INET6:
            # Ask for dual-stack where the kernel supports it. If the host has
            # net.ipv6.bindv6only=1, this remains IPv6-only and we bind IPv4 too.
            try:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except OSError:
                pass
            sock.bind((host, port, 0, 0))
        else:
            sock.bind((host, port))
        sock.listen(socket.SOMAXCONN)
        sock.set_inheritable(True)
        return sock
    except OSError:
        sock.close()
        return None


def _is_dual_stack(sock: socket.socket) -> bool:
    if sock.family != socket.AF_INET6:
        return False
    try:
        return sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 0
    except OSError:
        return False


def _auto_sockets(port: int) -> list[socket.socket]:
    sockets: list[socket.socket] = []
    ipv6 = _make_socket(socket.AF_INET6, "::", port)
    if ipv6 is not None:
        sockets.append(ipv6)

    if ipv6 is None or not _is_dual_stack(ipv6):
        ipv4 = _make_socket(socket.AF_INET, "0.0.0.0", port)
        if ipv4 is not None:
            sockets.append(ipv4)

    if not sockets:
        raise RuntimeError(f"Could not bind nia-todo on port {port} for IPv4 or IPv6")
    return sockets


def _socket_labels(sockets: Iterable[socket.socket]) -> str:
    labels = []
    for sock in sockets:
        host, port, *_ = sock.getsockname()
        labels.append(f"{host}:{port}")
    return ", ".join(labels)


def main() -> None:
    host = os.getenv("NIA_TODO_HOST", "auto").strip() or "auto"
    port = int(os.getenv("NIA_TODO_PORT", "8753"))
    proxy_headers = _env_bool("NIA_TODO_PROXY_HEADERS", False)

    config = uvicorn.Config(
        "main:app",
        host=host,
        port=port,
        proxy_headers=proxy_headers,
        forwarded_allow_ips="",
    )
    server = uvicorn.Server(config)

    if host.lower() == "auto":
        sockets = _auto_sockets(port)
        print(f"🚀 Starting nia-todo on {_socket_labels(sockets)}", flush=True)
        server.run(sockets=sockets)
    else:
        print(f"🚀 Starting nia-todo on {host}:{port}", flush=True)
        server.run()


if __name__ == "__main__":
    main()
