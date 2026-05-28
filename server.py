#!/usr/bin/env python3
"""English Practice Web App"""
import http.server
import json
import os
import csv
import urllib.parse
import socketserver

WEB_DIR   = os.path.dirname(os.path.abspath(__file__))
CLIPS_DIR = os.path.join(WEB_DIR, "clips")
CSV_FILE  = os.path.join(WEB_DIR, "data", "문법별_예문_정리.csv")
PORT      = int(os.environ.get('PORT', 8080))

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_GET(self):
        raw  = self.path.split('?')[0]
        path = urllib.parse.unquote(raw)

        if path == '/api/sentences':
            self._json(self._sentences())
        elif path == '/api/clips':
            self._serve_json_file('clips_mapping.json')
        elif path.startswith('/clip/'):
            self._clip(path[6:])
        else:
            fname = 'index.html' if path in ('/', '') else path.lstrip('/')
            self._static(os.path.join(WEB_DIR, fname))

    def _sentences(self):
        rows = []
        with open(CSV_FILE, encoding='utf-8-sig') as f:
            for r in csv.DictReader(f):
                rows.append({
                    'grammar': r['문법'],
                    'number':  r['번호'],
                    'korean':  r['한국어'],
                    'english': r['영어'],
                })
        return rows

    def _serve_json_file(self, filename):
        filepath = os.path.join(WEB_DIR, filename)
        if os.path.isfile(filepath):
            with open(filepath, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type',   'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json({})

    def _clip(self, rel_path):
        full = os.path.realpath(os.path.join(CLIPS_DIR, rel_path))
        if not full.startswith(os.path.realpath(CLIPS_DIR)):
            self.send_response(403); self.end_headers(); return
        self._send_audio_file(full)

    def _send_audio_file(self, path):
        if not os.path.isfile(path):
            self.send_response(404); self.end_headers(); return

        size = os.path.getsize(path)
        ct   = 'audio/mpeg' if path.lower().endswith('.mp3') else 'audio/mp4'
        rng  = self.headers.get('Range', '')

        if rng.startswith('bytes='):
            s_str, _, e_str = rng[6:].partition('-')
            s = int(s_str) if s_str else 0
            e = int(e_str) if e_str else size - 1
            length = e - s + 1
            self.send_response(206)
            self.send_header('Content-Type',   ct)
            self.send_header('Content-Range',  f'bytes {s}-{e}/{size}')
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges',  'bytes')
            self.end_headers()
            with open(path, 'rb') as f:
                f.seek(s); self.wfile.write(f.read(length))
        else:
            self.send_response(200)
            self.send_header('Content-Type',   ct)
            self.send_header('Content-Length', str(size))
            self.send_header('Accept-Ranges',  'bytes')
            self.end_headers()
            with open(path, 'rb') as f:
                self.wfile.write(f.read())

    def _static(self, path):
        if not os.path.isfile(path):
            self.send_response(404); self.end_headers(); return
        ct = MIME.get(os.path.splitext(path)[1], 'application/octet-stream')
        with open(path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type',   ct)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), Handler) as srv:
        srv.allow_reuse_address = True
        print(f'서버 시작: http://localhost:{PORT}')
        print('종료하려면 Ctrl+C 를 누르세요.')
        srv.serve_forever()
