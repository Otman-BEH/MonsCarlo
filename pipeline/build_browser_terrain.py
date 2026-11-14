#!/usr/bin/env python3
"""
build_browser_terrain.py

Packs coarse terrain for the browser so that horizon masks can be ray-cast for
custom coordinates (web/src/lib/terrain.ts). Listed sites keep using the
precomputed masks from compute_horizon_masks.py, which are far more detailed.

Layers written to web/public/data/terrain:
    polar_400m.bin.gz    block mean of the regional 80 m (or 40 m) grid, to 80 S
    polar_1200m.bin.gz   block mean of the 240 m grid, to 60 S
    global_4ppd.bin.gz   whole Moon at 1/4 degree, only when a source is given
    terrain.json         manifest

The global layer comes from the LLNL ssa-data-lunar package (LOLA-derived,
1/8 degree, MIT). It is rebuilt only if that package is installed or
--global-npz points at its moon_dem.npz; otherwise an existing
global_4ppd.bin.gz is kept and stays listed in the manifest.

Encoding (same as MonsCarlo-Best build/pack.py, MIT): int16 metres, each row
stored as differences along the row with int16 wrap-around, split into a low
byte plane followed by a high byte plane, then gzip. -32768 marks no data.

Usage (PowerShell, from the project folder):
    python pipeline\\build_browser_terrain.py
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from compute_horizon_masks import (FAR_NAME, R_MOON, REGIONAL_CANDIDATES, RasterFile,
                                   default_base_dir, find_file, xy_to_ll)

NODATA = -32768
POLAR_FINE_TARGET_M = 400.0
POLAR_FINE_MAX_RANGE_M = 60_000.0
MAX_RANGE_M = 330_000.0
GLOBAL_FILE = "global_4ppd.bin.gz"
GLOBAL_STEP_M = 3000.0


def encode(a: np.ndarray) -> bytes:
    """int16 array -> row-delta byte planes -> gzip."""
    a = np.ascontiguousarray(a, dtype=np.int16)
    d = a.copy()
    d[:, 1:] = a[:, 1:] - a[:, :-1]                    # wraps in int16, undone by the decoder
    u = d.astype("<i2").view(np.uint8).reshape(-1, 2)
    raw = np.concatenate([u[:, 0], u[:, 1]]).tobytes()
    return gzip.compress(raw, 9, mtime=0)


def to_int16(mean: np.ndarray) -> np.ndarray:
    out = np.full(mean.shape, NODATA, dtype=np.int16)
    ok = np.isfinite(mean)
    out[ok] = np.clip(np.rint(mean[ok]), -32767, 32767).astype(np.int16)
    return out


def block_mean(rf: RasterFile, factor: int) -> np.ndarray:
    """NaN-aware block mean of a whole raster, read in strips."""
    import rasterio
    from rasterio.windows import Window

    out_w = -(-rf.width // factor)
    out_h = -(-rf.height // factor)
    out = np.full((out_h, out_w), np.nan, dtype=np.float32)
    strip = 128                                         # output rows per read
    with rasterio.open(rf.path) as src, warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)       # all-NaN blocks
        for o0 in range(0, out_h, strip):
            o1 = min(out_h, o0 + strip)
            r0, r1 = o0 * factor, min(rf.height, o1 * factor)
            arr = src.read(1, window=Window(0, r0, rf.width, r1 - r0)).astype(np.float32)
            arr = rf._clean(arr) * np.float32(rf.unit_factor)
            pad = np.full(((o1 - o0) * factor, out_w * factor), np.nan, dtype=np.float32)
            pad[: arr.shape[0], : arr.shape[1]] = arr
            out[o0:o1] = np.nanmean(pad.reshape(o1 - o0, factor, out_w, factor), axis=(1, 3))
    return out


def polar_layer(rf: RasterFile, target_px: float, name: str, max_range: float, out_dir: Path) -> dict:
    factor = max(1, int(round(target_px / rf.px)))
    mean = block_mean(rf, factor)
    data = to_int16(mean)
    blob = encode(data)
    file = f"{name}.bin.gz"
    (out_dir / file).write_bytes(blob)
    px = rf.px * factor
    h, w = data.shape
    edge_lat = float(xy_to_ll(rf.x0 + w * px / 2.0, rf.y0)[0])
    valid = int((data != NODATA).sum())
    print(f"  {file}: {w} x {h} @ {px:g} m from {rf.name} (x{factor}), "
          f"heights {int(data[data != NODATA].min())}..{int(data.max())} m, "
          f"{100.0 * valid / data.size:.1f}% valid, edge-mid latitude {edge_lat:.2f}, {len(blob) / 1024:.0f} kB")
    for w_ in rf.warnings:
        print(f"      WARNING ({rf.name}): {w_}")
    return {
        "name": name, "kind": "polar", "file": file, "width": w, "height": h,
        "x0_m": rf.x0, "y0_m": rf.y0, "pixel_size_m": px,
        "step_m": px, "max_range_m": max_range, "source": rf.name,
    }


def global_layer(npz_path: Path | None, out_dir: Path) -> dict | None:
    if npz_path is None:
        try:
            import ssa_data_lunar
            npz_path = Path(ssa_data_lunar.__file__).resolve().parent / "data" / "moon_dem.npz"
        except ImportError:
            return None
    if not npz_path.is_file():
        print(f"  global source not found: {npz_path}")
        return None
    d = np.load(npz_path)["elev_km"].astype(np.float64) * 1000.0      # 1440 x 2880, row 0 = +90, col 0 = -180
    if d.shape != (1440, 2880):
        print(f"  unexpected global grid shape {d.shape}; skipped")
        return None
    g = d.reshape(720, 2, 1440, 2).mean(axis=(1, 3))
    data = to_int16(g)
    blob = encode(data)
    (out_dir / GLOBAL_FILE).write_bytes(blob)
    print(f"  {GLOBAL_FILE}: 1440 x 720 @ 1/4 deg from {npz_path.name}, "
          f"heights {int(data.min())}..{int(data.max())} m, {len(blob) / 1024:.0f} kB")
    return {
        "name": "global_4ppd", "kind": "global", "file": GLOBAL_FILE, "width": 1440, "height": 720,
        "pixels_per_degree": 4, "step_m": GLOBAL_STEP_M, "max_range_m": MAX_RANGE_M,
        "source": "LLNL ssa-data-lunar moon_dem.npz (LOLA-derived, 1/8 deg, 2 x 2 mean)",
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Pack coarse terrain layers for in-browser ray casting.")
    ap.add_argument("--base-dir", type=Path, default=default_base_dir())
    ap.add_argument("--out-dir", type=Path, default=None, help="default: <base-dir>/web/public/data/terrain")
    ap.add_argument("--global-npz", type=Path, default=None, help="path to ssa-data-lunar moon_dem.npz")
    args = ap.parse_args(argv)
    base = args.base_dir.expanduser().resolve()
    out_dir = (args.out_dir or base / "web" / "public" / "data" / "terrain").expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    reg_dir = base / "data" / "dem_regional"

    regional = next((p for p in (find_file(reg_dir, c) for c in REGIONAL_CANDIDATES) if p is not None), None)
    far = find_file(reg_dir, FAR_NAME)
    print(f"writing browser terrain to {out_dir}")
    layers: list[dict] = []
    if regional is not None:
        layers.append(polar_layer(RasterFile(regional), POLAR_FINE_TARGET_M, "polar_400m",
                                  POLAR_FINE_MAX_RANGE_M if far is not None else MAX_RANGE_M, out_dir))
    else:
        print("  regional DEM not found: no 400 m layer")
    if far is not None:
        layers.append(polar_layer(RasterFile(far), 1200.0, "polar_1200m", MAX_RANGE_M, out_dir))
    else:
        print(f"  {FAR_NAME} not found: no 1200 m layer")

    glob = global_layer(args.global_npz, out_dir)
    manifest_path = out_dir / "terrain.json"
    if glob is None and (out_dir / GLOBAL_FILE).is_file() and manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        glob = next((layer for layer in old.get("layers", []) if layer.get("kind") == "global"), None)
        if glob is not None:
            print(f"  {GLOBAL_FILE}: kept existing file")
    if glob is not None:
        layers.append(glob)
    else:
        print("  no global layer: custom coordinates north of 60 S will see a smooth sphere")

    manifest = {
        "schema_version": 1,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "radius_m": R_MOON,
        "nodata": NODATA,
        "encoding": "int16 metres; row delta with int16 wrap; low byte plane then high byte plane; gzip",
        "projection": "polar layers: south polar stereographic on the sphere, lon_0 = 0, k = 1, pixel-registered; "
                      "global layer: row 0 at +90, column 0 at -180, pixel centres at half steps",
        "layers": layers,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"wrote {manifest_path} with {len(layers)} layer(s)")
    return 0 if layers else 1


if __name__ == "__main__":
    sys.exit(main())
