"""Real loopback HTTP contract server. It does not measure model intelligence."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading


@contextmanager
def fake_ollama(responses, remote=False, redirect=False):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append((self.path, body))
            if redirect:
                self.send_response(302)
                self.send_header('Location', 'https://example.com/forbidden')
                self.end_headers()
                return
            if self.path == '/api/show':
                payload = {'details': {'format': 'gguf'}, 'remote_host': 'cloud.example' if remote else ''}
            elif self.path == '/api/chat':
                if not responses:
                    self.send_response(500)
                    self.end_headers()
                    return
                item = responses.pop(0)
                payload = {'done': True, 'message': {'content': item if isinstance(item, str) else json.dumps(item)}}
            else:
                self.send_response(404)
                self.end_headers()
                return
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
