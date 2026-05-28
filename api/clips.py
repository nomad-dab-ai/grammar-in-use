from http.server import BaseHTTPRequestHandler
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        filepath = os.path.join(ROOT, 'clips_mapping.json')
        with open(filepath, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
