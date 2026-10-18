#!/usr/bin/env python3
"""Fake S3-compatible server for cloud-backup E2E testing (no real cloud needed).
Listens on :19002, path-style addressing, auth headers ignored.
  PUT  /{bucket}/{key}    -> store object
  GET  /{bucket}?list-type=2&prefix=... -> ListObjectsV2 XML
  GET  /{bucket}/{key}    -> object bytes
  DELETE /{bucket}/{key}  -> remove
Store: /tmp/fake-s3-store/<bucket>/<key>
"""
import http.server
import os
import re
import shutil
import time
import urllib.parse
from datetime import datetime, timezone

PORT = 19002
STORE = '/tmp/fake-s3-store'
# keep store across restarts: shutil.rmtree removed
os.makedirs(STORE, exist_ok=True)


class FakeS3(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print(f'[fake-s3] {self.command} {self.path}')

    def _bucket_key(self):
        path = urllib.parse.unquote(self.path.lstrip('/'))
        if '/' not in path:
            return path, ''
        b, k = path.split('/', 1)
        return b, k

    def _object_path(self):
        b, k = self._bucket_key()
        safe = os.path.normpath(k).lstrip('/')
        if '..' in safe.split('/'):
            return None
        return os.path.join(STORE, b, safe)

    def do_PUT(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        p = self._object_path()
        if not p or p.endswith('/'):
            self.send_error(400, 'bad key')
            return
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(body)
        self.send_response(200)
        self.send_header('ETag', '"fake"')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        bucket = parsed.path.lstrip('/')
        qs = urllib.parse.parse_qs(parsed.query)

        if not bucket or '/' not in bucket:  # list request (no key)
            prefix = qs.get('prefix', [''])[0]
            bdir = os.path.join(STORE, bucket or '')
            entries = []
            if os.path.isdir(bdir):
                for root, _dirs, files in os.walk(bdir):
                    for fn in files:
                        fp = os.path.join(root, fn)
                        key = os.path.relpath(fp, os.path.join(STORE, bucket))
                        if prefix and not key.startswith(prefix):
                            continue
                        entries.append((key, os.path.getsize(fp), os.path.getmtime(fp)))
            items = ''.join(
                f'<Contents><Key>{urllib.parse.quote(k)}</Key><LastModified>'
                f'{datetime.fromtimestamp(m, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")}'
                f'</LastModified><ETag>"fake"</ETag><Size>{s}</Size>'
                f'<StorageClass>STANDARD</StorageClass></Contents>'
                for k, s, m in sorted(entries)
            )
            xml = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f'<Name>{bucket}</Name><Prefix>{prefix}</Prefix><KeyCount>{len(entries)}</KeyCount>'
                f'<MaxKeys>60</MaxKeys><IsTruncated>false</IsTruncated>{items}</ListBucketResult>'
            )
            body = xml.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/xml')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        p = self._object_path()
        if not p or not os.path.isfile(p):
            self.send_error(404, 'no such key')
            return
        with open(p, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self):
        p = self._object_path()
        if p and os.path.isfile(p):
            os.remove(p)
            self.send_response(204)
        else:
            self.send_response(404)
        self.send_header('Content-Length', '0')
        self.end_headers()


if __name__ == '__main__':
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), FakeS3)
    print(f'[fake-s3] listening on :{PORT}, store {STORE}')
    srv.serve_forever()
