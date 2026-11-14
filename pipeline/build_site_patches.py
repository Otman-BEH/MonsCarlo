#!/usr/bin/env python3
"""Fine terrain patches around each listed south polar site, for the browser.

Adapted from build/patches.py in MonsCarlo-Best (MIT). For every site in
data/horizon_masks/index.json that lies inside the 80 m regional DEM:

    patch_<site>_80m    76 x 76 native 80 m pixels, about +-3 km
    patch_<site>_240m   126 x 126 pixels of 3 x 3 means, about +-15 km

They are written next to the other browser layers and added to terrain.json
as ordinary polar layers, so web/src/lib/terrain.ts picks them up with no
special case. The landing-risk analysis needs them for touchdown slopes and
per-cell horizons; without them it falls back to the 400 m layer.

Run after build_browser_terrain.py, which rewrites terrain.json from scratch:

    python pipeline/build_site_patches.py
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

from build_browser_terrain import encode, to_int16
from compute_horizon_masks import REGIONAL_CANDIDATES, SITES, RasterFile, default_base_dir, find_file, ll_to_xy

PREFIX = "patch_"
# (suffix, block factor, half size in 80 m pixels, farthest range sampled on the layer in metres)
LEVELS = (("80m", 1, 38, 3000.0), ("240m", 3, 189, 15000.0))


def read_window(rf: RasterFile, r0: int, c0: int, n: int) -> np.ndarray:
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(rf.path) as src:
        arr = src.read(1, window=Window(c0, r0, n, n)).astype(np.float32)
    return rf._clean(arr) * np.float32(rf.unit_factor)


def load_sites(base: Path) -> list[tuple[str, float, float]]:
    index = base / "data" / "horizon_masks" / "index.json"
    if index.is_file():
        doc = json.loads(index.read_text(encoding="utf-8"))
        print(f"sites from {index}")
        return [(s["site_id"], float(s["lat"]), float(s["lon"])) for s in doc["sites"]]
    print("data/horizon_masks/index.json not found: using the nominal site list")
    return [(s.site_id, s.lat, s.lon) for s in SITES]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Cut 80 m and 240 m terrain patches around the listed sites.")
    ap.add_argument("--base-dir", type=Path, default=default_base_dir())
    ap.add_argument("--out-dir", type=Path, default=None, help="default: <base-dir>/web/public/data/terrain")
    ap.add_argument("--dem", type=Path, default=None, help="80 m south polar DEM; default: found in data/dem_regional")
    args = ap.parse_args(argv)
    base = args.base_dir.expanduser().resolve()
    out_dir = (args.out_dir or base / "web" / "public" / "data" / "terrain").expanduser().resolve()
    manifest_path = out_dir / "terrain.json"
    if not manifest_path.is_file():
        print(f"{manifest_path} not found: run build_browser_terrain.py first")
        return 1
    reg_dir = base / "data" / "dem_regional"
    dem = args.dem or next((p for p in (find_file(reg_dir, c) for c in reversed(REGIONAL_CANDIDATES)) if p is not None), None)
    if dem is None:
        print(f"no regional DEM in {reg_dir}")
        return 1
    rf = RasterFile(dem)
    if abs(rf.px - 80.0) > 0.5:
        print(f"{rf.name} has {rf.px:g} m pixels; this script expects the 80 m DEM (pass it with --dem)")
        return 1
    for w_ in rf.warnings:
        print(f"WARNING ({rf.name}): {w_}")
    print(f"cutting patches from {rf.name} ({rf.px:g} m) into {out_dir}")

    layers: list[dict] = []
    total = 0
    for site_id, lat, lon in load_sites(base):
        x, y = (float(v) for v in ll_to_xy(max(lat, -89.9999), lon))
        c = int(np.floor((x - rf.x0) / rf.px))
        r = int(np.floor((rf.y0 - y) / rf.px))
        made = []
        for suffix, f, half_px, max_range in LEVELS:
            n = (2 * half_px) // f
            r1, c1 = r - half_px, c - half_px
            if r1 < 0 or c1 < 0 or r1 + n * f > rf.height or c1 + n * f > rf.width:
                continue                                    # too close to the map edge, or outside it
            blk = read_window(rf, r1, c1, n * f)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=RuntimeWarning)
                mean = np.nanmean(blk.reshape(n, f, n, f), axis=(1, 3))
            data = to_int16(mean)
            if not (data != -32768).any():
                continue
            blob = encode(data)
            name = f"{PREFIX}{site_id}_{suffix}"
            (out_dir / f"{name}.bin.gz").write_bytes(blob)
            total += len(blob)
            px = rf.px * f
            layers.append({
                "name": name, "kind": "polar", "file": f"{name}.bin.gz", "width": n, "height": n,
                "x0_m": rf.x0 + c1 * rf.px, "y0_m": rf.y0 - r1 * rf.px, "pixel_size_m": px,
                "step_m": px, "max_range_m": max_range, "source": f"{rf.name}, patch around {site_id}",
            })
            made.append(f"{suffix} {n} x {n}, {int(data[data != -32768].min())}..{int(data.max())} m")
        print(f"  {site_id}: " + ("; ".join(made) if made else "outside the DEM, no patch"))

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    kept = [layer for layer in manifest.get("layers", []) if not str(layer.get("name", "")).startswith(PREFIX)]
    for old in out_dir.glob(f"{PREFIX}*.bin.gz"):
        if old.name not in {layer["file"] for layer in layers}:
            old.unlink()
    manifest["layers"] = kept + layers
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"wrote {len(layers)} patch layer(s), {total / 1024:.0f} kB, into {manifest_path} "
          f"({len(manifest['layers'])} layers in total)")
    return 0 if layers else 1


if __name__ == "__main__":
    sys.exit(main())
