"""What the 5 m PGDA tiles change: horizon difference (best vs 80m mode, at 2 m) and the change in sunlit and Earth-in-view
time over a window, for every listed site a 5 m tile covers. Prints a Markdown table.

    python tools/compare_5m.py [--start 2026-12-01T00:00:00Z] [--days 30]
"""
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from monscarlo.engine import landers as LD  # noqa: E402
from monscarlo.engine import sites as SI  # noqa: E402
from monscarlo.engine.service import Engine, parse_time  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-12-01T00:00:00Z")
    ap.add_argument("--days", type=float, default=30)
    a = ap.parse_args()
    E = Engine()
    t0 = parse_time(a.start)
    ld = LD.resolve("reference")
    print(f"Window: {a.days:g} days from {a.start}, mast 2 m, reference lander\n")
    print("| Site | 5 m tile | horizon diff max (deg) | horizon diff RMS (deg) | sunlit % 80m -> 5m | Earth in view % 80m -> 5m |")
    print("|---|---|---|---|---|---|")
    for s in SI.catalogue():
        loc = SI.resolve(s["id"])
        tier = E.sky.terrain.best_tier(loc.lat, loc.lon)
        if not tier.startswith("LOLA 5 m"):
            continue
        hb, mb = E.sky.get(loc, [2.0], "best")
        h8, m8 = E.sky.get(loc, [2.0], "80m")
        d = mb[2.0] - m8[2.0]
        wb = E.windows(loc, t0, t0 + a.days * 86400, ld, "best")["stats"]
        w8 = E.windows(loc, t0, t0 + a.days * 86400, ld, "80m")["stats"]
        print(f"| {s['name']} | {tier[len('LOLA 5 m ('):-1]} | {np.abs(d).max():.2f} | {np.sqrt((d * d).mean()):.2f} | "
              f"{w8['sunlit_pct']:.1f} -> {wb['sunlit_pct']:.1f} | {w8['earth_in_view_pct']:.1f} -> {wb['earth_in_view_pct']:.1f} |")


if __name__ == "__main__":
    main()
