"""HTTP server for the Dark Universe guide. Keeps the API key off the browser.

    pip install anthropic
    export ANTHROPIC_API_KEY=...
    python guide/server.py            # http://127.0.0.1:8787, proxied by Vite at /api

Endpoints
  POST /api/guide          {turns:[{role,content}...], level, stop?, page?, context?}
                           -> streamed text/plain (UTF-8), one chunk per model delta
  GET  /api/guide/status   -> PROJECT STATUS JSON (team notes + pipeline outputs)
  GET  /api/guide/health   -> {ok, has_key, model}

Stdlib only apart from the anthropic SDK. Binds to 127.0.0.1 unless GUIDE_HOST is set.
A per-IP limit (GUIDE_RATE, questions per minute, default 12) protects the demo's credits.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tour_guide import DEFAULT_MODEL, FAST_MODEL, LEVELS, Guide, build_project_status, clean_turns  # noqa: E402

HOST = os.environ.get("GUIDE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GUIDE_PORT", "8787"))
RATE = int(os.environ.get("GUIDE_RATE", "12"))
MODEL = FAST_MODEL if os.environ.get("GUIDE_FAST") else DEFAULT_MODEL
MAX_BODY = 64 * 1024

_hits: dict[str, deque] = defaultdict(deque)
_lock = threading.Lock()
GUIDE: Guide | None = None  # created lazily, or injected by tests


def _allow(ip: str) -> bool:
    now = time.monotonic()
    with _lock:
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= RATE:
            return False
        q.append(now)
        return True


def _guide() -> Guide:
    global GUIDE
    if GUIDE is None:
        GUIDE = Guide(model=MODEL)
    return GUIDE


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PenumbraGuide/1"

    def log_message(self, fmt, *args):  # quieter: one line per request
        sys.stderr.write("guide %s %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/guide/status":
            return self._json(200, build_project_status())
        if path == "/api/guide/health":
            return self._json(200, {"ok": True, "has_key": bool(os.environ.get("ANTHROPIC_API_KEY")) or GUIDE is not None,
                                    "model": MODEL})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/api/guide":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "request too large"})
        try:
            req = json.loads(self.rfile.read(length))
            turns = clean_turns(req.get("turns"))
        except (ValueError, AttributeError) as e:
            return self._json(400, {"error": str(e) or "bad request"})
        if not _allow(self.client_address[0]):
            return self._json(429, {"error": "rate_limited"})
        if GUIDE is None and not os.environ.get("ANTHROPIC_API_KEY"):
            return self._json(503, {"error": "no_key"})
        level = req.get("level") if req.get("level") in LEVELS else "new"
        stop = req.get("stop") if isinstance(req.get("stop"), int) else None
        page = str(req.get("page") or "")[:20] or None
        context = req.get("context") if isinstance(req.get("context"), dict) else None

        try:
            stream = _guide().stream_turns(turns, level=level, stop=stop, page=page, context=context)
            first = next(stream, None)  # fail before headers if the API call itself fails
        except Exception as e:  # noqa: BLE001 - report upstream errors to the client
            sys.stderr.write(f"guide upstream error: {e!r}\n")
            return self._json(502, {"error": "upstream_error"})

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def write(text: str):
            data = text.encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()

        try:
            if first:
                write(first)
            for chunk in stream:
                if chunk:
                    write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return  # visitor pressed Stop
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"guide stream error: {e!r}\n")
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("note: ANTHROPIC_API_KEY is not set; /api/guide will answer 503 until it is.", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"guide server on http://{HOST}:{PORT} (model {MODEL}, {RATE} questions/min per visitor)", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
