#!/usr/bin/env python3
"""Pure transport doubles: no DNS, sockets, service or database are contacted."""
import email.message
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from services import public_fetch as fetch


class Reply:
    def __init__(self, body=b"<html></html>", status=200, headers=None):
        self.status, self.body = status, body
        self.headers = email.message.Message()
        for key, value in (headers or {"Content-Type": "text/html; charset=utf-8"}).items():
            self.headers[key] = value
        self.closed = False
    def getheader(self, key, default=None): return self.headers.get(key, default)
    def read1(self, size):
        result, self.body = self.body[:size], self.body[size:]
        return result
    def close(self): self.closed = True


class FetchTests(unittest.TestCase):
    def run_fetch(self, replies, url="https://recipes.example/recipe", **options):
        calls = []
        class Connection:
            sock = None
            def __init__(self, host, port, family, address, **kw):
                self.host, self.address, self.port = host, address, port
                calls.append(self)
            def request(self, method, path, headers): self.requested = (method, path, headers)
            def getresponse(self): return replies.pop(0)
            def close(self): self.closed = True
        with patch.object(fetch.socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34',443))]), patch.object(fetch, '_PinnedConnection', Connection):
            return fetch.fetch_public(url, **options), calls

    def test_reject_urls(self):
        for url in ['file:///etc/passwd','ftp://host/a','https://user:secret@x.example/a','https://x.example:22/a','http://x.example:443/a','https://x.example/\r\nX:foo','https://x.example\\@127.0.0.1/','https://[fe80::1%25eth0]/']:
            with self.subTest(url=url), self.assertRaises(fetch.PublicFetchError): fetch.normalize_public_url(url)
        self.assertEqual(fetch.normalize_public_url('https://ExAmple.com:443/a#part'), 'https://example.com/a')
        self.assertEqual(fetch.normalize_public_url('https://bücher.de/Rezeptsüß'), 'https://xn--bcher-kva.de/Rezepts%C3%BC%C3%9F')

    def test_private_literals_and_transitions(self):
        for address in ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.2','169.254.169.254','0.0.0.0','224.0.0.1','100.64.0.1','::1','fc00::1','fe80::1','::ffff:8.8.8.8','2002:0808:0808::1','2001::1','64:ff9b::7f00:1','64:ff9b::a00:1','64:ff9b:1::7f00:1']:
            self.assertFalse(fetch._public_ip(address), address)
        self.assertTrue(fetch._public_ip('8.8.8.8'))
        self.assertTrue(fetch._public_ip('2001:4860:4860::8888'))

    def test_dns_mixed_and_numeric_host(self):
        mixed = [(socket.AF_INET, socket.SOCK_STREAM,6,'',('8.8.8.8',443)), (socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]
        with patch.object(fetch.socket, 'getaddrinfo', return_value=mixed), self.assertRaises(fetch.PublicFetchError) as result:
            fetch._addresses('rebind.example',443,1)
        self.assertEqual(result.exception.code,'recipe.import.blockedUrl')
        with patch.object(fetch.socket, 'getaddrinfo') as resolver:
            self.assertEqual(fetch._addresses('8.8.8.8',443,1),[(socket.AF_INET,'8.8.8.8')]); resolver.assert_not_called()

    def test_pinned_get_and_charset(self):
        response, calls = self.run_fetch([Reply(body=b'hello')],url='https://recipes.example/abc?q=2#title')
        self.assertEqual(response.body,b'hello'); self.assertEqual(response.charset,'utf-8')
        self.assertEqual(calls[0].address,'93.184.216.34')
        self.assertEqual(calls[0].requested[1],'/abc?q=2')
        headers=calls[0].requested[2]
        self.assertEqual(headers['Host'],'recipes.example'); self.assertEqual(headers['Accept-Encoding'],'identity')
        self.assertNotIn('Cookie',headers); self.assertNotIn('Authorization',headers)
        self.assertTrue(calls[0].closed)

    def test_redirect_target_and_limits(self):
        response,calls=self.run_fetch([Reply(status=302,headers={'Location':'https://other.example/new'}), Reply(body=b'done')])
        self.assertEqual(response.url,'https://other.example/new'); self.assertEqual(len(calls),2)
        for target in ['http://127.0.0.1/private','http://169.254.169.254/latest','https://name:password@other.example','https://other.example:8080/']:
            with self.subTest(target=target), self.assertRaises(fetch.PublicFetchError):
                self.run_fetch([Reply(status=302,headers={'Location':target})])
        with self.assertRaises(fetch.PublicFetchError): self.run_fetch([Reply(status=302,headers={'Location':'/recipe'})])
        redirects=[Reply(status=302,headers={'Location':'/'+str(i)}) for i in range(10)]
        with self.assertRaises(fetch.PublicFetchError): self.run_fetch(redirects)

    def test_size_types_and_http_failure(self):
        for reply,code in [(Reply(body=b'123456'),'recipe.import.tooLarge'), (Reply(headers={'Content-Type':'text/html','Content-Length':'2000'}),'recipe.import.tooLarge'), (Reply(headers={'Content-Type':'text/html','Content-Length':'junk'}),'recipe.import.downloadFailed'), (Reply(headers={'Content-Type':'application/json'}),'recipe.import.unsupportedContent'), (Reply(headers={'Content-Type':'text/html','Content-Encoding':'gzip'}),'recipe.import.unsupportedContent'), (Reply(status=403),'recipe.import.downloadFailed')]:
            with self.subTest(code=code), self.assertRaises(fetch.PublicFetchError) as result: self.run_fetch([reply],max_bytes=5)
            self.assertEqual(result.exception.code,code)
            self.assertTrue(reply.closed)
        response,_=self.run_fetch([Reply(body=b'png',headers={'Content-Type':'image/png'})],image=True)
        self.assertEqual(response.content_type,'image/png')

    def test_slow_trickle_has_total_deadline(self):
        now=[10.]
        class Slow(Reply):
            def read1(self,size): now[0]+=3; return b'x'
        with patch.object(fetch.time,'monotonic',side_effect=lambda:now[0]), self.assertRaises(fetch.PublicFetchError) as result:
            self.run_fetch([Slow()],timeout=2)
        self.assertEqual(result.exception.code,'recipe.import.downloadFailed')

    def test_real_socket_slow_headers_and_close_delimited_body_are_bounded(self):
        # AF_UNIX socketpair is local in-process transport, with no listener,
        # external network, app service or database involved.
        for phase in ('headers','body'):
            with self.subTest(phase=phase):
                client, server = socket.socketpair()
                stop = threading.Event()
                original = fetch._PinnedConnection
                class LocalPinned(original):
                    def connect(self):
                        self.sock = client
                        self._deadline_socket = client
                        client.settimeout(.15)
                def trickle():
                    try:
                        server.recv(65536)
                        if phase == 'body':
                            server.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n')
                            data=b'body which is never finished'
                        else:
                            data=b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n'
                        for char in data:
                            if stop.wait(.025): break
                            server.sendall(bytes([char]))
                    except OSError: pass
                    finally: server.close()
                worker=threading.Thread(target=trickle,daemon=True); worker.start()
                started=time.monotonic()
                try:
                    with patch.object(fetch,'_addresses',return_value=[(socket.AF_INET,'8.8.8.8')]), patch.object(fetch,'_PinnedConnection',LocalPinned), self.assertRaises(fetch.PublicFetchError) as result:
                        fetch.fetch_public('http://recipes.example/', timeout=.15)
                    self.assertEqual(result.exception.code,'recipe.import.downloadFailed')
                    self.assertLess(time.monotonic()-started,1.5,'absolute deadline must interrupt both headers and a close-delimited body')
                finally:
                    stop.set(); client.close(); server.close(); worker.join(timeout=1)

    def test_tls_connect_pins_ip_but_verifies_hostname(self):
        class Sock:
            def settimeout(self,value): pass
            def connect(self,target): self.target=target
            def close(self): pass
            def do_handshake(self): pass
        sock=Sock()
        class Context:
            def wrap_socket(self,actual,server_hostname,do_handshake_on_connect):
                self.host=server_hostname; self.actual=actual; return actual
        context=Context()
        with patch.object(fetch.socket,'socket',return_value=sock), patch.object(fetch.ssl,'create_default_context',return_value=context), patch.object(fetch.socket,'getaddrinfo',side_effect=AssertionError('must not resolve again')):
            connection=fetch._PinnedConnection('real.example',443,socket.AF_INET,'8.8.8.8',tls=True,deadline=fetch.time.monotonic()+2)
            connection.connect()
        self.assertEqual(sock.target,('8.8.8.8',443)); self.assertEqual(context.host,'real.example')


if __name__ == '__main__': unittest.main()
