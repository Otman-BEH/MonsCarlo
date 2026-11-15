"""Serve the Mons Carlo web page (the web/ folder) on http://127.0.0.1:5173/.

The page calls the API at the address in web/config.js (default http://127.0.0.1:8000), so start the API too:
    cd backend && python run.py
Any static file server works the same way; this one only needs Python.

    python serve_web.py [--port 5173] [--host 127.0.0.1]
"""
import argparse
import functools
import http.server
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    with http.server.ThreadingHTTPServer((a.host, a.port), handler) as srv:
        print(f"Web page on http://{a.host}:{a.port}/  (API address set in web/config.js)")
        srv.serve_forever()


if __name__ == "__main__":
    main()
