"""Command line: the same endpoints and parameter names as the HTTP API.

    python -m monscarlo report site=shack
    python -m monscarlo sky site=mala time=2026-12-01T06:00:00Z
    python -m monscarlo mission site=shack landing_time=2026-12-14T00:00:00Z battery_wh=3000 risk=true
    python -m monscarlo windows lat=-85.4 lon=31.6 format=csv > windows.csv
    python -m monscarlo --url http://127.0.0.1:8000 report site=ridge     # ask a running server instead

Runs the engine in-process unless --url is given. Prints JSON (or CSV for format=csv); for report, --text prints only
the summary sentence.
"""
from __future__ import annotations

import argparse
import json
import sys

ENDPOINTS = ("report", "sky", "windows", "mission", "horizon", "sites", "landers", "health")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m monscarlo", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
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
    data = json.loads(body)
    if a.text and "summary" in data:
        print(data["summary"])
    else:
        print(json.dumps(data, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
