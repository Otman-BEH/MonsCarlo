"""Build derived products from raw files. Never modifies raw/. Skipped when the stamp matches.

Products (in derived/):
  coarse.npz, main_polar400.npz, main_profiles.npz   decoded from main's build/data.json (coarse global grid, 400 m polar
                                                     raster, main's 80 m site skylines) so the engine never reads base64
  <DEM>.npy + <DEM>.geo.npy                          only when a regional GeoTIFF is compressed (fast memory-mapping)
  skylines/<site>_<mode>.npy + skylines/index.json   site skylines, 720 azimuths x heights [0, 2, 5, 10, 20, 50, 100] m

    python -m skyline.prep.precompute [--force]
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

from .. import config
from .store import Store, default_store

STEP = "precompute"


def _unpack(b64: str, h: int, w: int) -> np.ndarray:
    """main's packing: gzip of two byte planes (low, high) of row-wise delta-coded int16 (src/terrain.js unpack)."""
    raw = np.frombuffer(gzip.decompress(base64.b64decode(b64)), dtype=np.uint8)
    n = h * w
    d = (raw[:n].astype(np.uint16) | (raw[n:2 * n].astype(np.uint16) << 8)).view(np.int16).reshape(h, w)
    # undo the horizontal delta with int16 wrap-around
    return np.cumsum(d.astype(np.int64), axis=1).astype(np.int64).astype(np.uint16).view(np.int16).astype(np.int16)


def build_main_derived(derived_dir: Path | None = None, data_json: Path | None = None) -> None:
    derived_dir = Path(derived_dir or config.DERIVED_DIR)
    derived_dir.mkdir(parents=True, exist_ok=True)
    d = json.loads(Path(data_json or config.MAIN_DATA_JSON).read_text())
    grids = {k: _unpack(d[k]["b64"], d[k]["h"], d[k]["w"]).astype(np.float32) for k in ("g", "s", "n")}
    _save_npz(derived_dir / "coarse.npz", **grids)
    p = d["p"]
    _save_npz(derived_dir / "main_polar400.npz", a=_unpack(p["b64"], p["n"], p["n"]), n=p["n"], km=p["km"], half=p["half"])
    hz = d["hz"]
    prof = {}
    for sid, q in hz["sites"].items():
        a = np.frombuffer(base64.b64decode(q["b64"]), dtype="<i2").reshape(len(hz["eyes"]), hz["naz"])
        prof[sid] = a.astype(np.float32) / 100.0
        prof[sid + "__meta"] = np.array([q["lat"], q["lon"], q["h0"]])
    _save_npz(derived_dir / "main_profiles.npz", eyes=np.array(hz["eyes"], dtype=np.float64), **prof)


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
    for p in (Path(__file__).resolve().parents[1] / "engine" / "sites.json", config.MAIN_DATA_JSON):
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
    log("precompute: decoding main's packed terrain")
    build_main_derived()
    _convert_compressed(log)
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
