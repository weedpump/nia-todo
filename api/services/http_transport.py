"""Bounded DNS and deadline-aware sockets shared by HTTP consumers.

This module supplies transport mechanics only. Public imports enforce their
own public-address policy; operator-configured LLM endpoints may be local.
"""

from __future__ import annotations

import concurrent.futures
import http.client
import ipaddress
import socket
import ssl
import threading
import time

DNS_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="nia-http-dns")
DNS_SLOTS = threading.BoundedSemaphore(8)


class DNSBusyError(RuntimeError):
    pass


def resolve_addresses(host: str, port: int, remaining: float, *, pool=DNS_POOL, slots=DNS_SLOTS) -> list[tuple[int, str]]:
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        return [(socket.AF_INET6 if literal.version == 6 else socket.AF_INET, host)]
    if not slots.acquire(blocking=False):
        raise DNSBusyError("DNS capacity is occupied")
    try:
        future = pool.submit(socket.getaddrinfo, host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except Exception:
        slots.release()
        raise
    future.add_done_callback(lambda _: slots.release())
    try:
        answers = future.result(timeout=max(.01, remaining))
        return list(dict.fromkeys((answer[0], answer[4][0]) for answer in answers))
    except (OSError, concurrent.futures.TimeoutError):
        future.cancel()
        raise OSError("DNS resolution failed or exceeded its deadline") from None


class DeadlineConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, family: int, address: str, *, tls: bool, deadline: float):
        super().__init__(host, port, timeout=max(.01, deadline - time.monotonic()))
        self.family, self.address, self.tls, self.deadline = family, address, tls, deadline
        self._deadline_socket = None
        self._deadline_expired = threading.Event()

    def abort_deadline(self):
        self._deadline_expired.set()
        sock = self._deadline_socket
        if sock is not None:
            try: sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            try: sock.close()
            except OSError: pass

    def _check_deadline(self):
        if self._deadline_expired.is_set() or time.monotonic() >= self.deadline:
            self.abort_deadline()
            raise TimeoutError()

    def connect(self):
        sock = socket.socket(self.family, socket.SOCK_STREAM)
        self._deadline_socket = sock
        try:
            self._check_deadline()
            sock.settimeout(max(.01, self.deadline - time.monotonic()))
            sock.connect((self.address, self.port))
            self._check_deadline()
            if self.tls:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host, do_handshake_on_connect=False)
                self._deadline_socket = sock
                self._check_deadline()
                sock.do_handshake()
            self._check_deadline()
            self.sock = sock
        except Exception:
            sock.close()
            raise


def start_deadline_watchdog(connection, deadline: float):
    timer = threading.Timer(max(.01, deadline - time.monotonic()), getattr(connection, "abort_deadline", lambda: None))
    timer.daemon = True
    timer.start()
    return timer


def close_deadline_connection(connection, timer):
    timer.cancel()
    connection.close()
    retained = getattr(connection, "_deadline_socket", None)
    if retained is not None:
        retained.close()
