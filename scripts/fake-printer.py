#!/usr/bin/env python3
"""Fake network printer for hardware E2E — listens on :19101, stores raw bytes
sent to it, responds like a dumb socket device. Stored bytes inspectable at
/tmp/fake-printer/last.bin (and count at sessions.log)."""
import http.server
import os

PORT = 19101
STORE = os.environ.get('MEDIPOS_PRINTER_STORE', '/tmp/fake-printer')
os.makedirs(STORE, exist_ok=True)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _store(self, body: bytes):
        with open(f'{STORE}/last.bin', 'wb') as f:
            f.write(body)
        with open(f'{STORE}/sessions.log', 'a') as f:
            f.write(f'{len(body)} bytes @ {__import__("time").strftime("%H:%M:%S")}\n')

    def do_GET(self):
        # health check
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        self._store(body)
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


if __name__ == '__main__':
    # raw TCP listener (what the drivers actually use) + keep process alive
    import socket
    import threading

    def raw_server():
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('127.0.0.1', PORT))
        srv.listen(5)
        sessions = 0
        while True:
            conn, _ = srv.accept()
            chunks = []
            try:
                conn.settimeout(3)
                while True:
                    data = conn.recv(65536)
                    if not data:
                        break
                    chunks.append(data)
            except Exception:
                pass
            finally:
                conn.close()
            body = b''.join(chunks)
            if body:
                sessions += 1
                with open(f'{STORE}/last.bin', 'wb') as f:
                    f.write(body)
                with open(f'{STORE}/sessions.log', 'a') as f:
                    f.write(f'#{sessions}: {len(body)} bytes\n')

    threading.Thread(target=raw_server, daemon=True).start()
    print(f'[fake-printer] raw TCP on :{PORT}')
    import time
    while True:
        time.sleep(60)
