#!/usr/bin/env python3
"""
make_ephemeris_truth.py

Reference Sun and Earth directions at lunar sites from JPL SPICE kernels, in
the MOON_ME frame. The front-end ephemeris (web/src/lib/ephemeris.ts, built on
astronomy-engine) is tested against this table by `npm test`.

Adapted from build/truth.py in MonsCarlo-Best (MIT). Changes: DE440 kernels
from data/kernels, leap seconds from the LSK instead of a fixed offset, sub-
point columns, and metadata in the output.

Usage (PowerShell, from the project folder):
    python pipeline\\make_ephemeris_truth.py

Kernels expected in data\\kernels: a planetary SPK (de440s.bsp), the lunar
binary PCK (moon_pa_de440_200625.bpc), the lunar frame kernel
(moon_de440_220930.tf), a leap second kernel (naif0012.tls) and a text PCK
(pck00011.tpc).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp

R_MOON_KM = 1737.4
FRAME = "MOON_ME"
ABCORR = "LT+S"

# (id, lat, lon east). A spread of latitudes, near side and far side, and the pole.
SITES = [
    ("south_pole", -90.0, 0.0),
    ("shackleton_rim", -89.78, 204.27),
    ("im2_mons_mouton", -84.7906, 29.1957),
    ("chandrayaan3", -69.373, 32.319),
    ("change6", -41.6385, 206.0148),
    ("blue_ghost", 18.562, 61.810),
    ("apollo11", 0.674, 23.473),
]

START_UTC = "2026-11-01T00:00:00"
STEP_S = 6 * 3600
N_EPOCHS = 3168           # 792 days, to early January 2029


def default_base_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here, *here.parents):
        if (cand / "data").is_dir():
            return cand
    return here.parent


def site_frame(lat_deg: float, lon_deg: float):
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    up = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    north = np.array([-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)])
    east = np.array([-math.sin(lo), math.cos(lo), 0.0])
    return up, north, east


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="SPICE reference table for the ephemeris tests.")
    ap.add_argument("--base-dir", type=Path, default=default_base_dir())
    ap.add_argument("--kernel-dir", type=Path, default=None, help="default: <base-dir>/data/kernels")
    ap.add_argument("--out", type=Path, default=None,
                    help="default: <base-dir>/web/test/fixtures/ephemeris_truth.json")
    args = ap.parse_args(argv)
    base = args.base_dir.expanduser().resolve()
    kdir = (args.kernel_dir or base / "data" / "kernels").expanduser().resolve()
    out = (args.out or base / "web" / "test" / "fixtures" / "ephemeris_truth.json").expanduser().resolve()

    kernels = sorted(p for p in kdir.iterdir()
                     if p.is_file() and p.suffix.lower() in (".bsp", ".bpc", ".tf", ".tls", ".tpc"))
    if not kernels:
        print(f"no kernels found in {kdir}")
        return 1
    have = {p.suffix.lower() for p in kernels}
    missing = {".bsp", ".bpc", ".tf", ".tls"} - have
    if missing:
        print(f"missing kernel types in {kdir}: {sorted(missing)}")
        return 1
    for p in kernels:
        sp.furnsh(str(p))
        print(f"loaded {p.name}")
    if sp.namfrm(FRAME) == 0:
        print(f"frame {FRAME} is not defined by the loaded frame kernel")
        return 1

    et0 = sp.str2et(START_UTC)
    unix0 = int(datetime.fromisoformat(START_UTC).replace(tzinfo=timezone.utc).timestamp())
    frames = [site_frame(lat, lon) for _, lat, lon in SITES]
    rows, subs = [], []
    for i in range(N_EPOCHS):
        # Step in UTC seconds so the table lines up with JavaScript Date arithmetic.
        utc = datetime.fromtimestamp(unix0 + i * STEP_S, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        et = sp.str2et(utc) if i else et0
        sun, _ = sp.spkpos("SUN", et, FRAME, ABCORR, "MOON")
        earth, _ = sp.spkpos("EARTH", et, FRAME, ABCORR, "MOON")
        row = []
        for up, north, east in frames:
            for v in (sun, earth):
                w = np.asarray(v) - R_MOON_KM * up
                w = w / np.linalg.norm(w)
                row.append(round(math.degrees(math.asin(max(-1.0, min(1.0, float(w @ up))))), 5))
                row.append(round(math.degrees(math.atan2(float(w @ east), float(w @ north))) % 360.0, 5))
        rows.append(row)
        sub = []
        for v in (sun, earth):
            d = float(np.linalg.norm(v))
            sub += [round(math.degrees(math.asin(v[2] / d)), 5),
                    round(math.degrees(math.atan2(v[1], v[0])), 5),
                    round(d, 1)]
        subs.append(sub)

    doc = {
        "description": "Sun and Earth elevation/azimuth at lunar sites from SPICE. "
                       "rows[i] = per site [sun_el, sun_az, earth_el, earth_az] in degrees; "
                       "sub_points[i] = [sun_lat, sun_lon, sun_dist_km, earth_lat, earth_lon, earth_dist_km].",
        "frame": FRAME,
        "aberration_correction": ABCORR,
        "observer": "site on the 1737.4 km sphere, height 0",
        "kernels": [p.name for p in kernels],
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "radius_km": R_MOON_KM,
        "sites": [{"id": s, "lat": la, "lon": lo} for s, la, lo in SITES],
        "t0_unix_s": unix0,
        "step_s": STEP_S,
        "rows": rows,
        "sub_points": subs,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print(f"{N_EPOCHS} epochs x {len(SITES)} sites from {START_UTC} UTC, step {STEP_S} s")
    print(f"first row, first site: {rows[0][:4]}")
    lat_s = [s[0] for s in subs]
    lon_e = [s[4] for s in subs]
    lat_e = [s[3] for s in subs]
    print(f"sub-solar latitude range {min(lat_s):.3f}..{max(lat_s):.3f} deg; "
          f"sub-Earth lon {min(lon_e):.3f}..{max(lon_e):.3f}, lat {min(lat_e):.3f}..{max(lat_e):.3f} deg")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
