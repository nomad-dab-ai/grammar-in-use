from http.server import BaseHTTPRequestHandler
import json, csv, os

ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_FILE = os.path.join(ROOT, 'data', '문법별_예문_정리.csv')

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        rows = []
        with open(CSV_FILE, encoding='utf-8-sig') as f:
            for r in csv.DictReader(f):
                rows.append({
                    'grammar': r['문법'],
                    'number':  r['번호'],
                    'korean':  r['한국어'],
                    'english': r['영어'],
                })
        body = json.dumps(rows, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
