# © 2026 Nokia
#
# Licensed under the 5G-MAG Public License (v1.0)

import http.server
import sys
import os
import mimetypes
import json

mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')

LEVELS = {'log': '', 'info': '', 'warn': 'WARN ', 'error': 'ERROR'}

# Mirror every forwarded browser log line to this file so it can be inspected
# offline (the agent reads it instead of scraping the terminal).
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'browser-console.log')


def _tee(line):
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except Exception:
        pass


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()

    def do_GET(self):
        # Convenience: redirect the bare root to the sample app.
        if self.path == '/' or self.path == '':
            self.send_response(302)
            self.send_header('Location', '/sample-app/index.html')
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/log':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8', errors='replace')
            try:
                data = json.loads(body)
                level = data.get('level', 'log')
                msg = data.get('msg', '')
                tag = '\033[33mWARN\033[0m ' if level == 'warn' else \
                      '\033[31mERROR\033[0m' if level == 'error' else \
                      '\033[36m[JS]\033[0m '
                print(f'{tag} {msg}', flush=True)
                _tee(f'{level.upper():5} {msg}')
            except Exception:
                print('[JS RAW]', body[:300], flush=True)
                _tee(f'RAW   {body[:300]}')
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        status = args[1] if len(args) > 1 else ''
        if str(status) not in ('200', '204', '304'):
            print(f'[HTTP] {format % args}', flush=True)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    # Serve from the package root so /sdk/, /sample-app/, /verify/ and /verification/ are reachable.
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    # Start each run with a fresh log file.
    try:
        open(LOG_FILE, 'w', encoding='utf-8').close()
    except Exception:
        pass
    # Threaded so one stalled client connection (e.g. a flaky wireless-adb phone) can't block the
    # whole server. daemon_threads lets it exit cleanly on Ctrl-C.
    server = http.server.ThreadingHTTPServer(('', port), DevHandler)
    server.daemon_threads = True
    print(f'Serving on http://localhost:{port}/sample-app/index.html  (console logs forwarded here)')
    server.serve_forever()
