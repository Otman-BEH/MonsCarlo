"""Build derived products from raw files. Never modifies raw/. Skipped when the stamp matches.

Products (in derived/):
  polar400.npy                         the 80 m DEM averaged to 400 m (5 x 5 blocks, as main's build/hires.py did for the
                                       browser): the web page's shadow map, and a stand-in if the 80 m DEM is missing
  <DEM>.npy + <DEM>.geo.npy            only when a regional GeoTIFF is compressed (fast memory-mapping)
  skylines/<site>_<mode>.npy + skylines/index.json   site skylines, 720 azimuths x heights [0, 2, 5, 10, 20, 50, 100] m

    python -m skyline.prep.precompute [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

from .. import config
from .store import Store, default_store

STEP = "precompute"


def build_polar400(log=print) -> None:
    from ..engine.terrain import Terrain
    T = Terrain()
    r = T.r80
    if r is None:
        log("  80 m DEM missing: no 400 m polar raster")
        return
    n = r.shape[0] // 5
    a = np.asarray(r.data[: n * 5, : n * 5], dtype=np.float32).reshape(n, 5, n, 5).mean(axis=(1, 3))
    _save_npy(config.DERIVED_DIR / "polar400.npy", np.rint(a).astype(np.int16))
    log(f"  polar400.npy: {n} x {n} cells of 400 m")


def _save_npz(path: Path, **arrays) -> None:
    tmp = path.with_name(path.stem + ".tmp.npz")
    np.savez(tmp, **arrays)
    tmp.replace(path)


def _save_npy(path: Path, a: np.ndarray) -> None:
    tmp = path.with_name(path.stem + ".tmp.npy")
    np.save(tmp, a)
    tmp.replace(path)


def load_sites() -> list[dict]:
    return json.loads((Path(__file__).resolve().parents[1] / "engine" / "sites.json").read_text())["sites"]


def site_coords(s: dict) -> tuple[float, float]:
    q = s.get("snapped")
    return (q["lat"], q["lon"]) if q else (s["lat"], s["lon"])


def inputs_hash(store: Store) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in config.RAW_DIR.rglob("*") if p.is_file() and p.suffix.lower() in (".tif", ".tiff")):
        rel = str(path.relative_to(config.DATA_DIR))
        rec = store.file_check(rel)
        h.update(rel.encode())
        h.update((rec["sha256"] if rec else f"size:{path.stat().st_size}").encode())
    for p in (Path(__file__).resolve().parents[1] / "engine" / "sites.json", config.ASSETS_DIR / "coarse_lola.npz"):
        h.update(hashlib.sha256(p.read_bytes()).hexdigest().encode())
    return h.hexdigest()


def _convert_compressed(log) -> None:
    import tifffile
    for fname in ("LDEM_80S_80MPP_ADJ.TIF", "LDEM_60S_240MPP_ADJ.TIF"):
        p = config.RAW_DIR / "dem_regional" / fname
        if not p.exists():
            continue
        with tifffile.TiffFile(p) as tf:
            compressed = tf.pages[0].compression != 1
        if not compressed:
            continue
        from ..engine.terrain import read_geotiff
        r = read_geotiff(p, fname, "")
        stem = fname.rsplit(".", 1)[0]
        log(f"  {fname} is compressed: writing {stem}.npy for memory-mapping")
        _save_npy(config.DERIVED_DIR / f"{stem}.npy", np.ascontiguousarray(r.data, dtype=np.float32))
        _save_npy(config.DERIVED_DIR / f"{stem}.geo.npy", np.array([r.x0, r.y0, r.px]))


def build_skylines(log=print) -> dict:
    from ..engine.terrain import Terrain
    out_dir = config.DERIVED_DIR / "skylines"
    out_dir.mkdir(parents=True, exist_ok=True)
    T = Terrain()
    index = {"eyes_m": config.EYES_M, "naz": config.NAZ, "sites": {}}
    for s in load_sites():
        lat, lon = site_coords(s)
        modes = []
        if lat <= -60 and (T.r240 is not None or T.r80 is not None or lat <= -80.02):
            modes.append("best")
        if s.get("snapped"):
            modes.append("80m")
        rec = {"lat": lat, "lon": lon, "modes": {}}
        for mode in modes:
            t0 = time.time()
            hm = T.horizon(lat, lon, config.EYES_M, config.NAZ, mode, use_cache=False)
            _save_npy(out_dir / f"{s['id']}_{mode}.npy", hm.mask_deg.astype(np.float32))
            rec["modes"][mode] = {"ground_m": hm.ground_m, "tiers": hm.tiers, "file": f"{s['id']}_{mode}.npy"}
            log(f"  skyline {s['id']:6s} {mode:4s} ground {hm.ground_m:8.1f} m  tiers {', '.join(hm.tiers)}  ({time.time() - t0:.1f} s)")
        if rec["modes"]:
            index["sites"][s["id"]] = rec
    (out_dir / "index.json").write_text(json.dumps(index, indent=1))
    return index


def run(force: bool = False, store: Store | None = None, log=print) -> bool:
    """Returns True when work was done, False when skipped."""
    store = store or default_store()
    config.DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    ih = inputs_hash(store)
    st = store.stamp(STEP)
    if not force and st and st["inputs_hash"] == ih and st["code_version"] == config.CODE_VERSION \
            and (config.DERIVED_DIR / "skylines" / "index.json").exists():
        log(f"precompute: up to date (stamp {st['done_utc']})")
        return False
    t0 = time.time()
    _convert_compressed(log)
    log("precompute: 400 m polar raster")
    build_polar400(log)
    log("precompute: site skylines")
    build_skylines(log)
    store.put_stamp(STEP, ih, config.CODE_VERSION)
    log(f"precompute: done in {time.time() - t0:.0f} s")
    return True


def stamp_ok(store: Store | None = None) -> bool:
    store = store or default_store()
    st = store.stamp(STEP)
    return bool(st and st["code_version"] == config.CODE_VERSION and (config.DERIVED_DIR / "skylines" / "index.json").exists())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    run(force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
