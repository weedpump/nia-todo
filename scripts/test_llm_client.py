#!/usr/bin/env python3
"""Pure shared-provider/access contracts; no app DB, service or model calls."""

import contextlib
import io
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from fastapi import HTTPException
from services import ai_access, llm_client
from services import http_transport


class LlmClientTests(unittest.TestCase):
    def test_provider_payloads_and_structured_output(self):
        payload = {"model": "local-test", "messages": [{"role": "user", "content": "test"}],
                   "temperature": 0, "max_tokens": 1234, "stream": False}
        self.assertIs(llm_client.request_payload(payload, {}), payload)
        ollama = llm_client.request_payload(payload, {"llm_provider": "ollama"})
        self.assertEqual(ollama, {"model": "local-test", "messages": payload["messages"],
                                  "stream": False, "options": {"temperature": 0, "num_predict": 1234}})
        formatted = llm_client.request_payload({**payload, "response_format": {"type": "json_object"}}, {"llm_provider": "ollama"})
        self.assertEqual(formatted["format"], "json")
        schema = {"type": "object", "properties": {"title": {"type": "string"}}}
        formatted = llm_client.request_payload({**payload, "response_format": {"type": "json_schema", "json_schema": {"schema": schema}}}, {"llm_provider": "ollama"})
        self.assertEqual(formatted["format"], schema)
        self.assertNotIn("format", ollama, "legacy BrainDump calls keep their provider body unchanged")

    def test_headers_share_validation_and_auth(self):
        headers = llm_client.build_headers({"llm_api_key": " dummy-test-key ", "llm_extra_headers_json": '{"X-Test":"enabled"}'})
        self.assertEqual(headers, {"Content-Type": "application/json", "Authorization": "Bearer dummy-test-key", "X-Test": "enabled"})
        self.assertNotIn("Authorization", llm_client.build_headers({}))
        for extra in ['{"Authorization":"override"}', '{"X-Test":"a\\r\\nb"}']:
            with self.assertRaises(HTTPException):
                llm_client.build_headers({"llm_extra_headers_json": extra})

    def test_response_and_retry_metadata(self):
        openai = {"choices": [{"message": {"content": '{"title":"test"}'}, "finish_reason": "stop"}],
                  "usage": {"completion_tokens": 10}}
        self.assertEqual(llm_client.response_content(openai, {}), '{"title":"test"}')
        self.assertEqual(llm_client.usage(openai, {}), {"completion_tokens": 10})
        self.assertFalse(llm_client.should_retry_empty(openai, {}))
        limited = {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}
        self.assertTrue(llm_client.should_retry_empty(limited, {}))
        reasoning = {"usage": {"completion_tokens_details": {"reasoning_tokens": 2}}}
        self.assertTrue(llm_client.should_retry_empty(reasoning, {}))
        ollama = {"message": {"content": "{}"}, "done_reason": "length", "eval_count": 0, "prompt_eval_count": 3}
        config = {"llm_provider": "ollama"}
        self.assertEqual(llm_client.response_content(ollama, config), "{}")
        self.assertEqual(llm_client.usage(ollama, config), {"prompt_tokens": 3, "completion_tokens": 0})
        self.assertTrue(llm_client.should_retry_empty(ollama, config))

    def test_transport_uses_configured_url_timeout_and_bounded_read(self):
        seen = {}
        class Response(io.BytesIO):
            def read(self, size=-1):
                seen["read_size"] = size
                return super().read(size)
        def open_url(request, timeout):
            seen.update(url=request.full_url, method=request.method, timeout=timeout,
                        body=json.loads(request.data), auth=request.get_header("Authorization"))
            return Response(b'{"choices":[]}')
        config = {"llm_base_url": "http://localhost:11434", "llm_provider": "ollama", "llm_timeout_seconds": 12}
        with patch.object(llm_client.urllib.request, "urlopen", side_effect=open_url):
            self.assertEqual(llm_client.post_chat({"model": "test"}, {"Authorization": "Bearer dummy"}, config), {"choices": []})
        self.assertEqual(seen, {"url": "http://localhost:11434/api/chat", "method": "POST", "timeout": 12,
                                "body": {"model": "test"}, "auth": "Bearer dummy", "read_size": llm_client.MAX_RESPONSE_BYTES + 1})

    def test_transport_rejects_oversized_and_non_object_responses(self):
        for data in [b'"private provider content"', b'[]', b'not-json']:
            with self.subTest(data=data), patch.object(llm_client.urllib.request, "urlopen", return_value=io.BytesIO(data)):
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    llm_client.post_chat({}, {}, {"llm_base_url": "https://example.invalid"})
        with patch.object(llm_client, "MAX_RESPONSE_BYTES", 10), patch.object(llm_client.urllib.request, "urlopen", return_value=io.BytesIO(b'x' * 20)):
            with self.assertRaisesRegex(ValueError, "response limit"):
                llm_client.post_chat({}, {}, {"llm_base_url": "https://example.invalid"})

    def test_access_global_user_and_missing_user_checks(self):
        calls = []
        config = {"enabled": True, "llm_api_key": "dummy"}
        def loader(**kwargs):
            self.assertEqual(kwargs, {"include_secrets": True})
            return config
        @contextlib.contextmanager
        def database():
            calls.append("open")
            yield "mock-database"
        def gate(db, user):
            self.assertEqual(db, "mock-database")
            if user == 2:
                raise PermissionError("braindump_not_enabled")
            if user == 3:
                raise PermissionError("user_not_found")
        result = ai_access.require_braindump_ai_access(1, config_loader=loader, database=database, user_gate=gate)
        self.assertIs(result, config)
        for user, expected in [(2, 403), (3, 404)]:
            with self.assertRaises(HTTPException) as raised:
                ai_access.require_braindump_ai_access(user, config_loader=loader, database=database, user_gate=gate)
            self.assertEqual(raised.exception.status_code, expected)
        calls.clear()
        config["enabled"] = False
        with self.assertRaises(HTTPException) as raised:
            ai_access.require_braindump_ai_access(1, config_loader=loader, database=database, user_gate=gate)
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(calls, [], "globally disabled features must not reach per-user state")

    def _socket_request(self, reply, *, timeout=.3):
        """Use an AF_UNIX pair, never a listener or a real provider."""
        client, server = socket.socketpair()
        stop = threading.Event()
        seen = {}
        original = llm_client.DeadlineConnection
        class LocalConnection(original):
            def connect(self):
                self.sock = client
                self._deadline_socket = client
                seen["endpoint"] = (self.host, self.port, self.address)
                client.settimeout(timeout)
        def respond():
            try:
                raw = b''
                while b'\r\n\r\n' not in raw:
                    part = server.recv(65536)
                    if not part: return
                    raw += part
                header, body = raw.split(b'\r\n\r\n', 1)
                length = next(int(line.split(b':', 1)[1]) for line in header.split(b'\r\n')[1:] if line.lower().startswith(b'content-length:'))
                while len(body) < length:
                    part = server.recv(65536)
                    if not part: return
                    body += part
                seen["header"], seen["body"] = header, json.loads(body)
                reply(server, stop)
            except OSError:
                pass
            finally:
                server.close()
        thread = threading.Thread(target=respond, daemon=True)
        thread.start()
        try:
            config = {"llm_base_url": "http://localhost:11434", "llm_provider": "ollama",
                      "_deadline_at": time.monotonic() + timeout}
            with patch.object(llm_client, "resolve_addresses", return_value=[(socket.AF_INET, '127.0.0.1')]) as dns, patch.object(llm_client, "DeadlineConnection", LocalConnection):
                result = llm_client.post_chat({"model": "test"}, {"Authorization": "Bearer dummy"}, config)
                self.assertEqual(dns.call_count, 1)
                return result, seen
        finally:
            stop.set()
            client.close()
            server.close()
            thread.join(timeout=1)

    def test_deadline_transport_allows_configured_local_ports_and_json(self):
        body = b'{"message":{"content":"{}"}}'
        def reply(server, stop):
            server.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        result, seen = self._socket_request(reply)
        self.assertEqual(result, {"message": {"content": "{}"}})
        self.assertEqual(seen['endpoint'], ('localhost', 11434, '127.0.0.1'))
        self.assertIn(b'Host: localhost:11434', seen['header'])
        self.assertIn(b'Authorization: Bearer dummy', seen['header'])
        self.assertEqual(seen['body'], {"model": "test"})

    def test_deadline_interrupts_slow_headers_and_close_delimited_body(self):
        for phase in ('headers', 'body'):
            with self.subTest(phase=phase):
                def reply(server, stop):
                    if phase == 'body':
                        server.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n')
                        slow = b'{"message":{"content":"very slow response"}}'
                    else:
                        slow = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'
                    for char in slow:
                        if stop.wait(.025): break
                        server.sendall(bytes([char]))
                started = time.monotonic()
                with self.assertRaises((OSError, ValueError)):
                    self._socket_request(reply, timeout=.15)
                self.assertLess(time.monotonic() - started, 1.5, 'absolute deadline must bound slow header and body trickles')

    def test_deadline_rejects_redirects_and_oversized_provider_body(self):
        def redirect(server, stop):
            server.sendall(b'HTTP/1.1 307 Temporary Redirect\r\nLocation: https://other.invalid/chat\r\nContent-Length: 0\r\n\r\n')
        with self.assertRaises(llm_client.urllib.error.HTTPError) as raised:
            self._socket_request(redirect)
        self.assertEqual(raised.exception.code, 307)
        def large(server, stop):
            server.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n' + b'x' * 20)
        with patch.object(llm_client, 'MAX_RESPONSE_BYTES', 10), self.assertRaisesRegex(ValueError, 'response limit'):
            self._socket_request(large)

    def test_dns_deadline_and_capacity_are_bounded(self):
        released = threading.Event()
        completed = threading.Event()
        slots = threading.BoundedSemaphore(1)
        def slow_dns(*args):
            try:
                released.wait(1)
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 11434))]
            finally:
                completed.set()
        try:
            with patch.object(http_transport.socket, 'getaddrinfo', side_effect=slow_dns):
                started = time.monotonic()
                with self.assertRaises(OSError):
                    http_transport.resolve_addresses('local-model.invalid', 11434, .02, slots=slots)
                self.assertLess(time.monotonic() - started, .5)
                with self.assertRaises(http_transport.DNSBusyError):
                    http_transport.resolve_addresses('other-model.invalid', 11434, 1, slots=slots)
        finally:
            released.set()
            self.assertTrue(completed.wait(1))
        with patch.object(llm_client, 'resolve_addresses') as dns, self.assertRaises(TimeoutError):
            llm_client.post_chat({}, {}, {'_deadline_at': time.monotonic() - 1})
        dns.assert_not_called()


if __name__ == "__main__":
    unittest.main()
