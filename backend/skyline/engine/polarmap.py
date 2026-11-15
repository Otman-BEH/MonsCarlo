"""Sunlight and Earth-view map of the south pole. Port of main's polar shadow caster (src/app.js at afd9e78: buildPolar,
castPolar, sunRaster and the colouring in drawMap), vectorised across pixels: one NumPy pass per ray-march step.

Grid: south polar stereographic on the 1737.4 km sphere, 80S to the pole (half-width about 304 km), pixel-registered
like the PGDA rasters: pixel (row, col) has its centre at x = (col + 0.5 - size/2) * px, y = (size/2 - row - 0.5) * px,
with +y toward the near side (lon 0, up in the image) and +x toward 90E.

Two terrain modes:
  best  heights from the 80 m DEM, box-averaged to the pixel size before sampling (no aliasing at coarse sizes)
  80m   main's 400 m raster with main's bilinear rule, and the coarse grid north of 80.02S, exactly as main's
        Terrain.elev, so the map can be checked against main pixel by pixel

For each pixel: march toward the body along main's step list (1 to 8 pixels, then x1.12 up to 190 pixels, in units of
main's 400 px grid), keep the steepest terrain angle with the curvature term, then the visible share of the disc
(geometry.disc_frac). Sun: direction only, radius 0.266 deg. Earth: full vector with parallax, radius 0.95 deg.
"""
from __future__ import annotations

import base64
import math
import struct
import threading
import zlib
from collections import OrderedDict
from pathlib import Path

import numpy as np

from .. import config

RM_KM = config.RM
CAP = -80.0
RHO_KM = 2 * RM_KM * math.tan((90 + CAP) / 2 * math.pi / 180)     # main's RHO, about 304.0 km
D2R = math.pi / 180
R2D = 180 / math.pi
SUN_RAD = 0.266
EARTH_RAD = 0.95
SIZES = (100, 1200)            # allowed range
GRID_VERSION = "1"


def steps(size: int) -> np.ndarray:
    """main's STEPS (pixels of its 400 px grid), scaled to this grid; at size 400 exactly main's list."""
    s = size / 400.0
    out = [float(d) for d in range(1, int(round(8 * s)) + 1)]
    d = 9.0
    while d < 190:
        out.append(d * s)
        d *= 1.12
    return np.array(out)


def grid_path(size: int, dem: str) -> Path:
    return config.DERIVED_DIR / "map" / f"grid_{dem}_{size}_v{GRID_VERSION}.npz"


def _geometry(size: int):
    px_km = 2 * RHO_KM / size
    c = (np.arange(size) + 0.5 - size / 2) * px_km
    X, Y = np.meshgrid(c, -c)                   # row 0 at the top (+y)
    rho = np.hypot(X, Y)
    lat = -90 + 2 * np.arctan(rho / (2 * RM_KM)) * R2D
    lon = np.arctan2(X, Y)                      # radians, as main
    return px_km, X, Y, rho, lat, lon


def build_grid(size: int, dem: str, terrain=None) -> dict:
    """Heights, trig of latitude and longitude, inside mask, hillshade and slope for one grid (float32, like main)."""
    from .terrain import default_terrain
    T = terrain or default_terrain()
    px_km, X, Y, rho, lat, lon = _geometry(size)
    if dem == "80m":
        P = T.p400
        if P is None:
            raise FileNotFoundError("the 400 m polar raster is missing: run python run.py (precompute) first")
        h = P.sample_main(X * 1000, Y * 1000)
        north = lat > -80.02
        if north.any():
            h[north] = T.coarse.elev(lat[north], lon[north] * R2D)
    else:
        r = T.r80 or T.p400
        if r is None:
            raise FileNotFoundError("the 80 m DEM is missing: run python -m skyline.prep.fetch_data")
        k = max(1, int(round(px_km * 1000 / r.px)))
        if k > 1:
            from scipy.ndimage import uniform_filter
            a = uniform_filter(np.asarray(r.data, dtype=np.float32), size=k, mode="nearest")
        else:
            a = np.asarray(r.data, dtype=np.float32)
        from .terrain import Raster
        h = Raster("map", r.tier, a, r.x0, r.y0, r.px, clamp=True).sample(X * 1000, Y * 1000)
    h = h.astype(np.float32)
    hd = h.astype(np.float64)
    gx = np.zeros_like(hd)
    gy = np.zeros_like(hd)
    gx[1:-1, 1:-1] = (hd[1:-1, 2:] - hd[1:-1, :-2]) / (2 * px_km * 1000)
    gy[1:-1, 1:-1] = (hd[2:, 1:-1] - hd[:-2, 1:-1]) / (2 * px_km * 1000)
    hill = np.zeros_like(hd)
    hill[1:-1, 1:-1] = np.clip(0.5 - 1.8 * (gx[1:-1, 1:-1] + gy[1:-1, 1:-1]), 0, 1)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    f32 = np.float32
    return {"size": size, "dem": dem, "px_km": px_km, "h": h, "sl": np.sin(lat * D2R).astype(f32), "cl": np.cos(lat * D2R).astype(f32),
            "so": np.sin(lon).astype(f32), "co": np.cos(lon).astype(f32), "inside": rho <= RHO_KM,
            "hill": hill.astype(f32), "slope": slope.astype(f32),
            "tier": "LOLA 400 m (main's raster)" if dem == "80m" else (T.r80.tier if T.r80 is not None else "LOLA 400 m")}


def save_grid(g: dict) -> None:
    p = grid_path(g["size"], g["dem"])
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.stem + ".tmp.npz")
    np.savez(tmp, **{k: v for k, v in g.items() if isinstance(v, np.ndarray)},
             meta=np.array([g["size"], g["px_km"]]), dem=np.array(g["dem"]), tier=np.array(g["tier"]))
    tmp.replace(p)


def load_grid(size: int, dem: str) -> dict | None:
    p = grid_path(size, dem)
    if not p.exists():
        return None
    z = np.load(p)
    g = {k: z[k] for k in ("h", "sl", "cl", "so", "co", "inside", "hill", "slope")}
    g.update(size=int(z["meta"][0]), px_km=float(z["meta"][1]), dem=str(z["dem"]), tier=str(z["tier"]))
    return g


def cast(g: dict, vec, finite: bool, rad: float) -> tuple[np.ndarray, np.ndarray]:
    """Visible share of the disc and the incidence factor (sine of the angle above the local slope) per pixel."""
    size, px_km = g["size"], g["px_km"]
    inside = g["inside"]
    rows, cols = np.nonzero(inside)
    sl = g["sl"][rows, cols].astype(np.float64)
    cl = g["cl"][rows, cols].astype(np.float64)
    so = g["so"][rows, cols].astype(np.float64)
    co = g["co"][rows, cols].astype(np.float64)
    nx, ny, nz = cl * co, cl * so, sl
    v = np.asarray(vec, dtype=np.float64)
    if finite:
        vx, vy, vz = v[0] - RM_KM * nx, v[1] - RM_KM * ny, v[2] - RM_KM * nz
        L = np.sqrt(vx * vx + vy * vy + vz * vz)
        ux, uy, uz = vx / L, vy / L, vz / L
    else:
        L = math.sqrt(float(v @ v))
        ux, uy, uz = v[0] / L, v[1] / L, v[2] / L
    el = np.arcsin(np.clip(ux * nx + uy * ny + uz * nz, -1, 1)) * R2D
    live = el >= -rad - 7
    sN = -ux * sl * co - uy * sl * so + uz * cl
    sE = -ux * so + uy * co
    dx = sN * so + sE * co
    dy = -(sN * co - sE * so)
    L2 = np.hypot(dx, dy)
    L2 = np.where(L2 == 0, 1.0, L2)
    dx, dy = dx / L2, dy / L2
    H = g["h"]
    h1 = H[rows, cols].astype(np.float64)
    x, y = cols.astype(np.float64), rows.astype(np.float64)
    mt = np.full(len(rows), -0.15)
    alive = live.copy()
    for d in steps(size):
        xx = np.floor(x + dx * d + 0.5)
        yy = np.floor(y + dy * d + 0.5)
        alive &= (xx >= 0) & (yy >= 0) & (xx < size) & (yy < size)
        if not alive.any():
            break
        idx = np.nonzero(alive)[0]
        dk = d * px_km
        tA = (H[yy[idx].astype(np.int64), xx[idx].astype(np.int64)] - h1[idx]) / (dk * 1000) - dk / (2 * RM_KM)
        mt[idx] = np.maximum(mt[idx], tA)
    hz = np.arctan(mt) * R2D
    dd = (el - hz) / rad
    dc = np.clip(dd, -1, 1)
    f = np.where(dd >= 1, 1.0, np.where(dd <= -1, 0.0, 1 - (np.arccos(dc) - dc * np.sqrt(1 - dc * dc)) / math.pi))
    cl_ = lambda a: np.clip(a, 0, size - 1)
    xa, ya = cl_(np.floor(x + dx * 1.5 + 0.5)).astype(np.int64), cl_(np.floor(y + dy * 1.5 + 0.5)).astype(np.int64)
    xb, yb = cl_(np.floor(x - dx * 1.5 + 0.5)).astype(np.int64), cl_(np.floor(y - dy * 1.5 + 0.5)).astype(np.int64)
    gsl = (H[ya, xa].astype(np.float64) - H[yb, xb]) / (3 * px_km * 1000)
    inc = np.maximum(0.0, np.sin((el + np.arctan(gsl) * R2D) * D2R))
    frac = np.zeros((size, size), np.float32)
    incg = np.zeros((size, size), np.float32)
    frac[rows, cols] = np.where(live, f, 0.0)
    incg[rows, cols] = np.where(live, inc, 0.0)
    return frac, incg


def colour(g: dict, layer: str, frac: np.ndarray, inc: np.ndarray) -> np.ndarray:
    """RGBA image exactly as main's drawMap colours it: hillshade base, warm light for the Sun, blue for Earth."""
    hill = g["hill"].astype(np.float64)
    fr = frac.astype(np.float64)
    base = 16 + 44 * hill
    if layer == "earth":
        f, k = fr, 0.4 + 0.6 * hill
        r, gg, b = base * (1 - f) + 60 * k * f, base * (1 - f) + 135 * k * f, (base + 8) * (1 - f) + 235 * k * f
    else:
        f = fr * np.power(np.minimum(1, inc.astype(np.float64) / 0.1), 0.55)
        k = 0.62 + 0.38 * hill
        r, gg, b = base * (1 - f) + 255 * k * f, base * (1 - f) + 236 * k * f, (base + 8) * (1 - f) + 200 * k * f
    img = np.zeros(frac.shape + (4,), np.uint8)
    for j, ch in enumerate((r, gg, b)):
        img[..., j] = np.clip(np.rint(ch), 0, 255).astype(np.uint8)
    img[..., 3] = np.where(g["inside"], 255, 0).astype(np.uint8)
    img[~g["inside"], :3] = 0
    return img


def png(rgba: np.ndarray) -> bytes:
    """Minimal PNG writer (8-bit RGBA, zlib), so no imaging library is needed."""
    h, w, _ = rgba.shape
    raw = np.zeros((h, 1 + 4 * w), np.uint8)
    raw[:, 1:] = rgba.reshape(h, 4 * w)
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw.tobytes(), 6)) + chunk(b"IEND", b""))


def b64u8(a: np.ndarray) -> str:
    return base64.b64encode(np.clip(np.rint(np.asarray(a, dtype=np.float64) * 255), 0, 255).astype(np.uint8).tobytes()).decode()


def pixel_of(size: int, lat: float, lon: float) -> tuple[float, float]:
    """(column, row) of a point as floats; integer values are pixel centres."""
    px_km = 2 * RHO_KM / size
    rho = 2 * RM_KM * math.tan((90 + max(-90.0, lat)) / 2 * D2R)
    x, y = rho * math.sin(lon * D2R), rho * math.cos(lon * D2R)
    return x / px_km + size / 2 - 0.5, size / 2 - 0.5 - y / px_km


class MapService:
    """Grids per (size, dem), loaded from derived/map or built on first use; casts cached in memory by (layer, hour, size, dem)."""

    def __init__(self, terrain=None, max_cached: int = 64):
        self.terrain = terrain
        self._grids: dict = {}
        self._casts: "OrderedDict[tuple, tuple]" = OrderedDict()
        self._lock = threading.Lock()
        self._glocks: dict = {}
        self.max_cached = max_cached

    def grid(self, size: int, dem: str) -> dict:
        key = (size, dem)
        with self._lock:
            g = self._grids.get(key)
            lk = self._glocks.setdefault(key, threading.Lock())
        if g is not None:
            return g
        with lk:
            g = self._grids.get(key) or load_grid(size, dem)
            if g is None:
                g = build_grid(size, dem, self.terrain)
                try:
                    save_grid(g)
                except OSError:
                    pass
            with self._lock:
                self._grids[key] = g
            return g

    def layer(self, layer: str, t: float, vec, size: int, dem: str) -> tuple[np.ndarray, np.ndarray, dict]:
        key = (layer, round(float(t), 3), size, dem)
        with self._lock:
            hit = self._casts.get(key)
            if hit is not None:
                self._casts.move_to_end(key)
                return hit
        g = self.grid(size, dem)
        frac, inc = cast(g, vec, layer == "earth", EARTH_RAD if layer == "earth" else SUN_RAD)
        hit = (frac, inc, g)
        with self._lock:
            self._casts[key] = hit
            while len(self._casts) > self.max_cached:
                self._casts.popitem(last=False)
        return hit
