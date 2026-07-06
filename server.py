#!/usr/bin/env python3
"""English Practice Web App"""
import http.server
import json
import os
import csv
import re
import base64
import urllib.parse
import socketserver

WEB_DIR       = os.path.dirname(os.path.abspath(__file__))
CLIPS_DIR     = os.path.join(WEB_DIR, "clips")
CSV_FILE      = os.path.join(WEB_DIR, "data", "문법별_예문_정리.csv")
PORT          = int(os.environ.get('PORT', 8080))
CLIPS_MAPPING = os.path.join(WEB_DIR, 'clips_mapping.json')
CONFIG_FILE   = os.path.join(WEB_DIR, 'config.json')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
}


def _is_admin_path(path):
    return path.startswith('/api/admin') or path in ('/admin', '/admin.html')


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _admin_blocked(self, path):
        """관리자 기능은 로컬 전용. Vercel(읽기 전용 FS)에서는 차단한다."""
        if os.environ.get('VERCEL') and _is_admin_path(path):
            self.send_response(404); self.end_headers()
            return True
        return False

    def do_GET(self):
        raw  = self.path.split('?')[0]
        path = urllib.parse.unquote(raw)
        if self._admin_blocked(path):
            return

        if path == '/api/sentences':
            self._json(self._sentences())
        elif path == '/api/clips':
            self._serve_json_file('clips_mapping.json')
        elif path.startswith('/clips/'):
            self._clip(path[7:])
        elif path in ('/admin', '/admin.html'):
            self._static(os.path.join(WEB_DIR, 'admin.html'))
        elif path == '/api/admin/config':
            self._get_config()
        elif path == '/api/admin/elevenlabs-voices':
            self._elevenlabs_voices()
        else:
            fname = 'index.html' if path in ('/', '') else path.lstrip('/')
            self._static(os.path.join(WEB_DIR, fname))

    def do_PUT(self):
        path = urllib.parse.unquote(self.path.split('?')[0])
        if self._admin_blocked(path):
            return
        if path == '/api/admin/sentences':
            self._update_sentences()
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        path = urllib.parse.unquote(self.path.split('?')[0])
        if self._admin_blocked(path):
            return
        if path == '/api/admin/upload-clip':
            self._upload_clip()
        elif path == '/api/admin/generate-clip':
            self._generate_clip()
        elif path == '/api/admin/config':
            self._save_config()
        else:
            self.send_response(404); self.end_headers()

    def _update_sentences(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            data   = json.loads(self.rfile.read(length).decode('utf-8'))
            with open(CSV_FILE, 'w', encoding='utf-8-sig', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['문법', '번호', '한국어', '영어'])
                for s in data:
                    writer.writerow([s['grammar'], s['number'], s['korean'], s['english']])
            self._json({'ok': True})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)})

    def _load_config(self):
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, encoding='utf-8') as f:
                return json.load(f)
        return {}

    def _get_config(self):
        cfg = self._load_config()
        key = cfg.get('elevenlabs_api_key', '')
        self._json({'elevenlabs_api_key': ('*' * 8 + key[-4:]) if len(key) > 4 else ('*' * len(key))})

    def _save_config(self):
        try:
            length  = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            cfg = self._load_config()
            if 'elevenlabs_api_key' in payload:
                cfg['elevenlabs_api_key'] = payload['elevenlabs_api_key']
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2)
            self._json({'ok': True})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)})

    def _elevenlabs_voices(self):
        import urllib.request, urllib.error
        try:
            cfg = self._load_config()
            api_key = cfg.get('elevenlabs_api_key', '')
            if not api_key:
                self._json({'ok': False, 'error': 'API 키 없음'}); return
            req = urllib.request.Request('https://api.elevenlabs.io/v1/voices')
            req.add_header('xi-api-key', api_key)
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            voices = [{'id': v['voice_id'], 'name': v['name'], 'labels': v.get('labels', {})}
                      for v in data.get('voices', [])]
            voices.sort(key=lambda v: v['name'])
            self._json({'ok': True, 'voices': voices})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)})

    def _generate_clip(self):
        import urllib.request, urllib.error, subprocess, tempfile
        try:
            length  = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            grammar  = payload['grammar']
            number   = str(payload['number'])
            text     = payload['text']
            voice    = payload.get('voice', '')
            use_el   = payload.get('elevenlabs', False)

            # A:/B: 레이블 제거
            clean_lines = [re.sub(r'^[A-Z]:\s*', '', l) for l in text.splitlines() if l.strip()]
            clean_text  = ' '.join(clean_lines)

            sentences = self._sentences()
            if not any(s['grammar'] == grammar and s['number'] == number for s in sentences):
                self._json({'ok': False, 'error': '문장을 찾을 수 없음'}); return

            key = f'{grammar}||{number}'
            with open(CLIPS_MAPPING) as f:
                clips = json.load(f)
            existing = clips.get(key)

            # 저장 경로 결정
            if existing:
                base    = os.path.splitext(existing)[0]
                rel_out = base + ('.mp3' if use_el else '.m4a')
            else:
                slug    = re.sub(r'[^\w]', '_', grammar).strip('_')
                ext     = '.mp3' if use_el else '.m4a'
                os.makedirs(os.path.join(CLIPS_DIR, 'generated'), exist_ok=True)
                rel_out = f'generated/{slug}_{number.zfill(3)}{ext}'

            out_path = os.path.join(CLIPS_DIR, rel_out.replace('/', os.sep))
            os.makedirs(os.path.dirname(out_path), exist_ok=True)

            if use_el:
                cfg     = self._load_config()
                api_key = cfg.get('elevenlabs_api_key', '')
                if not api_key:
                    self._json({'ok': False, 'error': 'ElevenLabs API 키가 없어요'}); return

                body = json.dumps({
                    'text': clean_text,
                    'model_id': 'eleven_multilingual_v2',
                    'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}
                }).encode('utf-8')
                req = urllib.request.Request(
                    f'https://api.elevenlabs.io/v1/text-to-speech/{voice}',
                    data=body, method='POST'
                )
                req.add_header('xi-api-key', api_key)
                req.add_header('Content-Type', 'application/json')
                req.add_header('Accept', 'audio/mpeg')
                with urllib.request.urlopen(req, timeout=30) as r:
                    audio_bytes = r.read()
                with open(out_path, 'wb') as f:
                    f.write(audio_bytes)
            else:
                tts_text = ' [[slnc 600]] '.join(clean_lines)
                with tempfile.NamedTemporaryFile(suffix='.aiff', delete=False) as tmp:
                    tmp_path = tmp.name
                try:
                    subprocess.run(['say', '-v', voice, '-o', tmp_path, tts_text], check=True)
                    subprocess.run(['afconvert', tmp_path, '-f', 'mp4f', '-d', 'aac', out_path], check=True)
                finally:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)

            clips[key] = rel_out
            with open(CLIPS_MAPPING, 'w') as f:
                json.dump(clips, f, ensure_ascii=False, indent=2)

            self._json({'ok': True, 'path': rel_out})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)})

    def _upload_clip(self):
        try:
            length  = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            grammar = payload['grammar']
            number  = str(payload['number'])
            mp3     = base64.b64decode(payload['data'])

            sentences = self._sentences()
            if not any(s['grammar'] == grammar and s['number'] == number for s in sentences):
                self._json({'ok': False, 'error': '문장을 찾을 수 없음'}); return

            key = f'{grammar}||{number}'
            with open(CLIPS_MAPPING) as f:
                clips = json.load(f)
            existing = clips.get(key)

            if existing:
                rel_path  = existing
                file_path = os.path.join(CLIPS_DIR, rel_path.replace('/', os.sep))
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
            else:
                slug      = re.sub(r'[^\w]', '_', grammar).strip('_')
                folder    = os.path.join(CLIPS_DIR, slug)
                os.makedirs(folder, exist_ok=True)
                filename  = f'{slug}_{number.zfill(3)}.mp3'
                file_path = os.path.join(folder, filename)
                rel_path  = f'{slug}/{filename}'
                clips[key] = rel_path
                with open(CLIPS_MAPPING, 'w') as f:
                    json.dump(clips, f, ensure_ascii=False, indent=2)

            with open(file_path, 'wb') as f:
                f.write(mp3)
            self._json({'ok': True, 'path': rel_path})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)})

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
