"""Start the Mons Carlo backend:  python run.py

1. verify or download the raw NASA / JPL files listed in manifest.json
2. precompute derived products (skipped when the stamp matches)
3. pre-fetch 14 months of ephemeris from JPL Horizons (SPICE fallback; failures do not stop startup)
4. start the API on http://127.0.0.1:8000  (interactive docs at /docs). The web page is served separately (serve_web.py).

Every step is safe to rerun and skips work already done.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monscarlo import config  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-fetch", action="store_true", help="do not check or download raw files")
    ap.add_argument("--skip-prefetch", action="store_true", help="do not pre-fetch ephemeris")
    ap.add_argument("--all-data", action="store_true", help="also fetch the optional files (illumination maps, hillshade, extra tiles)")
    ap.add_argument("--months", type=int, default=config.PREFETCH_MONTHS, help="months of ephemeris to pre-fetch")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-serve", action="store_true", help="prepare the data, then exit")
    a = ap.parse_args(argv)
    print(f"Mons Carlo backend {config.API_VERSION}, data in {config.DATA_DIR}")

    if not a.skip_fetch:
        from monscarlo.prep import fetch_data
        t = time.time()
        print("1/3 data files")
        rs = fetch_data.run(include_optional=a.all_data)
        fetch_data._print_table(rs)
        bad = [r for r in rs if r.status in ("failed", "missing")]
        if bad:
            print(f"    {len(bad)} file(s) could not be verified; the API will run with what is there (see /health)")
        print(f"    done in {time.time() - t:.0f} s")

    from monscarlo.prep import precompute
    print("2/3 precompute")
    precompute.run()

    if not a.skip_prefetch:
        from monscarlo.engine.ephemeris import default_ephemeris
        t = time.time()
        print(f"3/3 ephemeris: {a.months} months from JPL Horizons (cached months are skipped)")
        try:
            default_ephemeris().prefetch(a.months)
        except Exception as ex:   # a failure here must not stop the server: requests fetch on demand
            print(f"    pre-fetch stopped: {ex}")
        print(f"    done in {time.time() - t:.0f} s; cache: {default_ephemeris().coverage()}")

    if a.no_serve:
        return 0
    import uvicorn
    print(f"API on http://{a.host}:{a.port}  (docs: http://{a.host}:{a.port}/docs)")
    print("The web page is separate: python serve_web.py in the repo root, then open http://127.0.0.1:5173/")
    uvicorn.run("monscarlo.api.app:app", host=a.host, port=a.port, workers=1, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
