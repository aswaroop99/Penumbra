"""Serve the repo for the viewers with caching turned off, so the browser always loads the
latest data/ files after a re-export (plain `python3 -m http.server` lets browsers reuse old copies).

Usage:  python3 serve.py [port]      then open http://localhost:8000/viewer/
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving on http://localhost:{port}/viewer/  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
