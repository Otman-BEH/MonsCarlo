"""Command line: the same endpoints and parameter names as the HTTP API.

    python -m skyline report site=shack
    python -m skyline sky site=mala time=2026-12-01T06:00:00Z
    python -m skyline mission site=shack landing_time=2026-12-14T00:00:00Z battery_wh=3000 risk=true
    python -m skyline windows lat=-85.4 lon=31.6 format=csv > windows.csv
    python -m skyline compare sites=shack,ridge,mala
    python -m skyline landing-window site=mala plan_time=2026-12-01T06:00:00Z slip_days=14
    python -m skyline mission-design site=mala landing_time=2026-12-14T00:00:00Z
    python -m skyline map layer=earth format=png > earth.png
    python -m skyline --url http://127.0.0.1:8000 report site=ridge     # ask a running server instead

Runs the engine in-process unless --url is given. Prints JSON (or CSV for format=csv, PNG bytes for map format=png);
for report, --text prints only the summary sentence.
"""
from __future__ import annotations

import argparse
import json
import sys

ENDPOINTS = ("report", "sky", "windows", "mission", "horizon", "sites", "landers", "health",
             "map", "compare", "dsn", "landing-window", "mission-design", "mission-design/atlas")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m skyline", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("endpoint", choices=ENDPOINTS)
    ap.add_argument("params", nargs="*", help="key=value query parameters, as in the API")
    ap.add_argument("--url", help="base URL of a running server (default: run in-process)")
    ap.add_argument("--text", action="store_true", help="report: print only the summary sentence")
    a = ap.parse_args(argv)
    params = {}
    for p in a.params:
        if "=" not in p:
            ap.error(f"parameter {p!r} is not key=value")
        k, v = p.split("=", 1)
        params[k] = v
    if a.url:
        import requests
        r = requests.get(a.url.rstrip("/") + "/" + a.endpoint, params=params, timeout=120)
        status, ctype, body = r.status_code, r.headers.get("content-type", ""), r.text
    else:
        from fastapi.testclient import TestClient
        from .api.app import app
        r = TestClient(app).get("/" + a.endpoint, params=params)
        status, ctype, body = r.status_code, r.headers.get("content-type", ""), r.text
    if status >= 400:
        print(body, file=sys.stderr)
        return 1
    if ctype.startswith("text/csv"):
        sys.stdout.write(body)
        return 0
    if ctype.startswith("image/"):
        sys.stdout.buffer.write(r.content)
        return 0
    data = json.loads(body)
    if a.text and "summary" in data:
        print(data["summary"])
    else:
        print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
