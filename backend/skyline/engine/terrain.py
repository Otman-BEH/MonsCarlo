"""Terrain: elevation tiers, sampling, horizon masks (skylines), slope.

Tiers, finest first (mode "best"):
    5 m PGDA site tiles  ->  80 m LOLA DEM (80S to the pole)  ->  240 m LOLA DEM (60S to the pole)  ->  coarse global grid
Mode "80m" reproduces main: the 80 m DEM inside its square, main's distance schedule (build/hires.py), coarse grid beyond.

The coarse global grid is main's (build/pack.py: 1/4 deg global, 1/8 deg latitude polar caps), decoded by precompute into
derived/. When the regional DEMs are missing (for example a fresh clone before fetch_data), the engine falls back to main's
packed 400 m polar raster so it still answers, and says so in the tier names.

Rasters are south polar stereographic on the 1737.4 km sphere, pixel-registered: (x0, y0) is the outer corner of pixel (0, 0).
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

from .. import config
from ..config import R_M

D2R = np.pi / 180.0
R2D = 180.0 / np.pi
CAPLAT = -80.02           # main: polar raster used at or south of this latitude
RAW_TILE_SUFFIX = "_final_adj_5mpp_surf.tif"
REG80 = "LDEM_80S_80MPP_ADJ.TIF"
REG240 = "LDEM_60S_240MPP_ADJ.TIF"


# ---------------------------------------------------------------- projection
def ll_to_xy(lat, lon):
    """South polar stereographic (metres)."""
    lat = np.asarray(lat, dtype=np.float64)
    lo = np.asarray(lon, dtype=np.float64) * D2R
    rho = 2.0 * R_M * np.tan((90.0 + lat) / 2.0 * D2R)
    return rho * np.sin(lo), rho * np.cos(lo)


def xy_to_ll(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    return -90.0 + 2.0 * np.arctan(rho / (2.0 * R_M)) * R2D, np.arctan2(x, y) * R2D


def site_frame(lat: float, lon: float):
    la, lo = lat * D2R, lon * D2R
    p = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    n = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    e = np.array([-np.sin(lo), np.cos(lo), 0.0])
    return p, n, e


def ray_points(lat: float, lon: float, az_deg: np.ndarray, ranges_m: np.ndarray):
    """Unit vectors (qx, qy, qz) along great circles leaving the site, shape (n_az, n_range) each."""
    p, n, e = site_frame(lat, lon)
    az = az_deg * D2R
    d = np.cos(az)[:, None] * n[None, :] + np.sin(az)[:, None] * e[None, :]
    g = ranges_m / R_M
    cg, sg = np.cos(g)[None, :], np.sin(g)[None, :]
    return p[0] * cg + d[:, 0:1] * sg, p[1] * cg + d[:, 1:2] * sg, p[2] * cg + d[:, 2:3] * sg


def q_to_xy(qx, qy, qz):
    s = 2.0 * R_M / (1.0 - qz)
    return s * qy, s * qx


def q_to_ll(qx, qy, qz):
    return np.arcsin(np.clip(qz, -1, 1)) * R2D, np.arctan2(qy, qx) * R2D


# ---------------------------------------------------------------- rasters
@dataclass
class Raster:
    """North-up polar stereographic raster in metres. (x0, y0) = outer corner of pixel (0, 0)."""
    name: str
    tier: str            # label used in responses, e.g. "LOLA 5 m (Site04)"
    data: np.ndarray     # float32, metres above the 1737.4 km sphere
    x0: float
    y0: float
    px: float
    clamp: bool = False  # clamp to the edge (main's polar raster) instead of returning NaN outside

    @property
    def shape(self):
        return self.data.shape

    def contains(self, x, y, margin_px: float = 1.0):
        h, w = self.data.shape
        c = (np.asarray(x) - self.x0) / self.px - 0.5
        r = (self.y0 - np.asarray(y)) / self.px - 0.5
        return (c >= margin_px - 1) & (r >= margin_px - 1) & (c <= w - margin_px) & (r <= h - margin_px)

    def sample(self, x, y) -> np.ndarray:
        """Bilinear sample (metres). NaN outside unless clamp."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        h, w = self.data.shape
        c = (x - self.x0) / self.px - 0.5
        r = (self.y0 - y) / self.px - 0.5
        if self.clamp:
            c = np.clip(c, 0, w - 1.001)
            r = np.clip(r, 0, h - 1.001)
            return map_coordinates(self.data, [r.ravel(), c.ravel()], order=1, mode="nearest", prefilter=False,
                                   output=np.float64).reshape(x.shape)
        out = map_coordinates(self.data, [r.ravel(), c.ravel()], order=1, mode="constant", cval=np.nan, prefilter=False,
                              output=np.float64).reshape(x.shape)
        return out

    def sample_main(self, x, y) -> np.ndarray:
        """Main's bilinear rule (terrain.js elevXY / hires.py): clamp indices into [0, n - 1.001]."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        h, w = self.data.shape
        c = np.clip((x - self.x0) / self.px - 0.5, 0, w - 1.001)
        r = np.clip((self.y0 - y) / self.px - 0.5, 0, h - 1.001)
        c0 = np.floor(c).astype(np.int64)
        r0 = np.floor(r).astype(np.int64)
        fc, fr = c - c0, r - r0
        a = self.data
        return ((a[r0, c0] * (1 - fc) + a[r0, c0 + 1] * fc) * (1 - fr) + (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c0 + 1] * fc) * fr)


def read_geotiff(path: Path, name: str, tier: str) -> Raster:
    """Read a PGDA GeoTIFF with tifffile (memory-mapped when uncompressed) and its tie point and pixel scale."""
    import tifffile

    with tifffile.TiffFile(path) as tf:
        page = tf.pages[0]
        tags = page.tags
        tp = tags["ModelTiepointTag"].value
        sc = tags["ModelPixelScaleTag"].value
        compressed = page.compression != 1
        gk = (tf.geotiff_metadata or {}) if hasattr(tf, "geotiff_metadata") else {}
    try:
        data = tifffile.memmap(path, mode="r") if not compressed else tifffile.imread(path)
    except Exception:
        data = tifffile.imread(path)
    if data.dtype != np.float32:
        data = data.astype(np.float32)
    i, j, _, X, Y, _ = tp[:6]
    px = float(sc[0])
    if abs(float(sc[1]) - px) > 1e-9 * px:
        raise ValueError(f"{name}: non-square pixels {sc[:2]}")
    # GTRasterTypeGeoKey: 1 = PixelIsArea (tie point is the outer corner), 2 = PixelIsPoint (tie point is the centre)
    rtype = gk.get("GTRasterTypeGeoKey", 1)
    rtype = getattr(rtype, "value", rtype)
    x0 = float(X) - i * px
    y0 = float(Y) + j * px
    if int(rtype) == 2:
        x0 -= px / 2
        y0 += px / 2
    # Some PGDA products store kilometres; all of ours are metres (pixel scale 5, 80, 240), check anyway
    if px < 1.0:
        x0, y0, px = x0 * 1000, y0 * 1000, px * 1000
    return Raster(name=name, tier=tier, data=data, x0=x0, y0=y0, px=px)


# ---------------------------------------------------------------- coarse global grid (main's packing)
@dataclass
class Coarse:
    g: np.ndarray   # 720 x 1440, 1/4 deg, row 0 at +90
    s: np.ndarray   # 120 x 1440, 1/8 deg lat x 1/4 deg lon, -75 to -90
    n: np.ndarray   # 120 x 1440, +90 to +75

    @staticmethod
    def _bil(a: np.ndarray, r, c):
        h, w = a.shape
        r0 = np.clip(np.floor(r).astype(np.int64), 0, h - 2)
        fr = np.clip(r - r0, 0, 1)
        c0f = np.floor(c)
        fc = c - c0f
        c0 = np.mod(c0f.astype(np.int64), w)
        c1 = (c0 + 1) % w
        return (a[r0, c0] * (1 - fc) + a[r0, c1] * fc) * (1 - fr) + (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c1] * fc) * fr

    def elev(self, lat, lon) -> np.ndarray:
        """Main's elev() without the polar raster: metres above the 1737.4 km sphere."""
        lat = np.asarray(lat, dtype=np.float64)
        lon = np.asarray(lon, dtype=np.float64)
        c = np.mod(np.mod(lon + 180.0, 360.0) + 360.0, 360.0) * 4 - 0.5
        out = np.empty(np.broadcast(lat, lon).shape)
        latb = np.broadcast_to(lat, out.shape)
        cb = np.broadcast_to(c, out.shape)
        S = latb <= -75.0625
        N = latb >= 75.0625
        G = ~(S | N)
        if S.any():
            out[S] = self._bil(self.s, (-75 - latb[S]) * 8 - 0.5, cb[S])
        if N.any():
            out[N] = self._bil(self.n, (90 - latb[N]) * 8 - 0.5, cb[N])
        if G.any():
            out[G] = self._bil(self.g, (90 - latb[G]) * 4 - 0.5, cb[G])
        return out


# ---------------------------------------------------------------- distance schedules
def schedule_main_hires() -> np.ndarray:
    """build/hires.py: 30 m steps to 3 km, 60 m to 20 km, then x1.003 to 330 km."""
    d = np.concatenate([np.arange(30, 3000, 30.0), np.arange(3000, 20000, 60.0), 20000 * 1.003 ** np.arange(0, 930)])
    return d[d <= 330000]


def schedule_main_coarse() -> np.ndarray:
    """src/terrain.js horizonMask away from the polar raster: 1 km growing 4% per step to 320 km (metres)."""
    ds, d = [], 1.0
    while d <= 320:
        ds.append(d)
        d += max(1.0, d * 0.04)
    return np.array(ds) * 1000.0


def schedule_main_400() -> np.ndarray:
    """src/terrain.js horizonMask on the 400 m polar raster without a fine patch (metres)."""
    ds = []
    d = 0.2
    while d < 4 - 1e-12:
        ds.append(d); d += 0.2
    d = 4.0
    while d < 20 - 1e-12:
        ds.append(d); d += 0.4
    d = 20.0
    while d <= 320:
        ds.append(d); d *= 1.035
    return np.array(ds) * 1000.0


# ---------------------------------------------------------------- the terrain model
@dataclass
class HorizonMask:
    az_deg: np.ndarray            # (naz,)
    heights_m: list[float]
    mask_deg: np.ndarray          # (n_heights, naz)
    ground_m: float
    tiers: list[str]
    mode: str
    lat: float
    lon: float

    def at_height(self, h: float) -> np.ndarray:
        """Interpolate linearly between stored heights (main's profileMask)."""
        hs = self.heights_m
        if len(hs) == 1 or h <= hs[0]:
            return self.mask_deg[0]
        if h >= hs[-1]:
            return self.mask_deg[-1]
        k = int(np.searchsorted(hs, h, side="right") - 1)
        f = (h - hs[k]) / (hs[k + 1] - hs[k])
        return self.mask_deg[k] * (1 - f) + self.mask_deg[k + 1] * f


def mask_at(mask: np.ndarray, az) -> np.ndarray:
    """Linear interpolation of a mask sampled at i * 360 / n (main's maskAt)."""
    n = mask.shape[-1]
    x = np.mod(np.mod(np.asarray(az, dtype=np.float64), 360.0) + 360.0, 360.0) * n / 360.0
    i = np.floor(x).astype(np.int64) % n
    f = x - np.floor(x)
    return mask[..., i] * (1 - f) + mask[..., (i + 1) % n] * f


class Terrain:
    """All terrain tiers. Rasters load lazily and stay in memory."""

    def __init__(self, raw_dir: Path | None = None, derived_dir: Path | None = None):
        self.raw_dir = Path(raw_dir or config.RAW_DIR)
        self.derived_dir = Path(derived_dir or config.DERIVED_DIR)
        self._lock = threading.RLock()
        self._coarse: Coarse | None = None
        self._r80: Raster | None | bool = None
        self._r240: Raster | None | bool = None
        self._p400: Raster | None | bool = None
        self._tiles: dict[str, Raster] | None = None
        self._cache: OrderedDict = OrderedDict()

    # ----- loading
    @property
    def coarse(self) -> Coarse:
        with self._lock:
            if self._coarse is None:
                p = self.derived_dir / "coarse.npz"
                if not p.exists():
                    from ..prep.precompute import build_main_derived
                    build_main_derived(self.derived_dir)
                z = np.load(p)
                self._coarse = Coarse(g=z["g"], s=z["s"], n=z["n"])
            return self._coarse

    def _load_reg(self, fname: str, tier: str) -> Raster | None:
        npy = self.derived_dir / (fname.rsplit(".", 1)[0] + ".npy")
        meta = self.derived_dir / (fname.rsplit(".", 1)[0] + ".geo.npy")
        if npy.exists() and meta.exists():
            m = np.load(meta)
            return Raster(fname, tier, np.load(npy, mmap_mode="r"), float(m[0]), float(m[1]), float(m[2]))
        p = self.raw_dir / "dem_regional" / fname
        if not p.exists():
            return None
        r = read_geotiff(p, fname, tier)
        return r

    @property
    def r80(self) -> Raster | None:
        with self._lock:
            if self._r80 is None:
                self._r80 = self._load_reg(REG80, "LOLA 80 m") or False
            return self._r80 or None

    @property
    def r240(self) -> Raster | None:
        with self._lock:
            if self._r240 is None:
                self._r240 = self._load_reg(REG240, "LOLA 240 m") or False
            return self._r240 or None

    @property
    def p400(self) -> Raster | None:
        """main's packed 400 m polar raster (fallback when the 80 m DEM is not on disk)."""
        with self._lock:
            if self._p400 is None:
                p = self.derived_dir / "main_polar400.npz"
                if not p.exists():
                    from ..prep.precompute import build_main_derived
                    build_main_derived(self.derived_dir)
                z = np.load(p)
                self._p400 = Raster("main 400 m polar raster", "LOLA 400 m (main's packed raster)", z["a"].astype(np.float32),
                                    -float(z["half"]) * 1000, float(z["half"]) * 1000, float(z["km"]) * 1000, clamp=True)
            return self._p400 or None

    @property
    def tiles(self) -> dict[str, Raster]:
        with self._lock:
            if self._tiles is None:
                self._tiles = {}
                d = self.raw_dir / "dem_sites"
                if d.is_dir():
                    for p in sorted(d.glob("*" + RAW_TILE_SUFFIX)):
                        nm = p.name[: -len(RAW_TILE_SUFFIX)]
                        try:
                            self._tiles[nm] = read_geotiff(p, p.name, f"LOLA 5 m ({nm})")
                        except Exception:
                            continue
            return self._tiles

    def available(self) -> dict:
        return {"tiles_5m": sorted(self.tiles), "dem_80m": self.r80 is not None, "dem_240m": self.r240 is not None}

    def polar(self) -> Raster:
        """The polar raster main's '80m' logic uses: the 80 m DEM, else main's 400 m fallback."""
        return self.r80 or self.p400

    def tile_for(self, lat: float, lon: float, margin_m: float = 200.0) -> Raster | None:
        if lat > -80:
            return None
        x, y = ll_to_xy(lat, lon)
        best, bd = None, -1.0
        for t in self.tiles.values():
            h, w = t.shape
            dx = min(x - t.x0, t.x0 + w * t.px - x)
            dy = min(t.y0 - y, y - (t.y0 - h * t.px))
            d = min(dx, dy)
            if d > margin_m and d > bd:
                best, bd = t, d
        return best

    # ----- elevation
    def elev(self, lat, lon, mode: str = "best") -> np.ndarray:
        """Height (m) above the 1737.4 km sphere, from the finest tier that covers each point."""
        lat = np.atleast_1d(np.asarray(lat, dtype=np.float64))
        lon = np.atleast_1d(np.asarray(lon, dtype=np.float64))
        lat, lon = np.broadcast_arrays(lat, lon)
        out = np.full(lat.shape, np.nan)
        x, y = ll_to_xy(lat, lon)
        if mode == "best":
            polar = lat < -80
            for t in self.tiles.values():
                h, w = t.shape
                todo = polar & np.isnan(out) & (x >= t.x0) & (x <= t.x0 + w * t.px) & (y <= t.y0) & (y >= t.y0 - h * t.px)
                if todo.any():
                    out[todo] = t.sample(x[todo], y[todo])
            for r in (self.r80, self.r240):
                if r is None:
                    continue
                h, w = r.shape
                todo = np.isnan(out) & (np.abs(x - (r.x0 + w * r.px / 2)) <= w * r.px / 2) & (np.abs(y - (r.y0 - h * r.px / 2)) <= h * r.px / 2)
                if todo.any():
                    out[todo] = r.sample(x[todo], y[todo])
        else:
            P = self.polar()
            todo = lat <= CAPLAT
            if todo.any():
                out[todo] = P.sample_main(x[todo], y[todo])
        todo = np.isnan(out)
        if todo.any():
            out[todo] = self.coarse.elev(lat[todo], lon[todo])
        return out

    def ground(self, lat: float, lon: float, mode: str = "best") -> float:
        return float(self.elev(lat, lon, mode)[0])

    def best_tier(self, lat: float, lon: float) -> str:
        t = self.tile_for(lat, lon)
        if t is not None:
            return t.tier
        x, y = ll_to_xy(lat, lon)
        for r in (self.r80, self.r240):
            if r is not None and bool(r.contains(x, y)):
                return r.tier
        if lat <= CAPLAT and self.r80 is None:
            return self.p400.tier
        return "LOLA coarse grid (" + ("1/8 deg" if abs(lat) > 75 else "1/4 deg") + ")"

    # ----- slope (main's definition: central differences over +-80 m)
    def slope_xy(self, x, y, mode: str = "best") -> np.ndarray:
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        h = 80.0

        def E(xx, yy):
            la, lo = xy_to_ll(xx, yy)
            return self.elev(la, lo, mode).reshape(np.shape(xx))
        dzx = E(x + h, y) - E(x - h, y)
        dzy = E(x, y + h) - E(x, y - h)
        return np.arctan(np.hypot(dzx, dzy) / (2 * h)) * R2D

    def slope(self, lat: float, lon: float, mode: str = "best") -> float:
        x, y = ll_to_xy(lat, lon)
        return float(self.slope_xy(np.array([x]), np.array([y]), mode)[0])

    # ----- horizon
    def horizon(self, lat: float, lon: float, heights_m=None, naz: int = config.NAZ, mode: str = "best",
                ground_m: float | None = None, use_cache: bool = True, fast: bool = False) -> HorizonMask:
        """Skyline at each height. fast=True samples the finest tier at each point on main's hires distance schedule
        (30 m steps near the site): used for the Monte Carlo grid, where hundreds of skylines are needed."""
        heights = [float(h) for h in (heights_m if heights_m is not None else config.EYES_M)]
        lat = float(max(-89.9999, min(89.9999, lat)))
        lon = float(lon)
        key = (round(lat, 6), round(lon, 6), tuple(heights), naz, mode, ground_m, fast)
        if use_cache:
            with self._lock:
                if key in self._cache:
                    self._cache.move_to_end(key)
                    return self._cache[key]
        hm = self._cast(lat, lon, heights, naz, mode, ground_m, fast)
        if use_cache:
            with self._lock:
                self._cache[key] = hm
                while len(self._cache) > 256:
                    self._cache.popitem(last=False)
        return hm

    def _tiers(self, lat: float, lon: float, mode: str):
        """List of (sampler, ranges_m, label). A sampler returns NaN where it has no data."""
        tiers = []
        if mode == "80m":
            P = self.polar()
            x, y = ll_to_xy(lat, lon)
            if lat <= CAPLAT or bool(P.contains(x, y)):
                rng = schedule_main_hires() if P is self.r80 else schedule_main_400()
                half = -P.x0
                margin = P.px

                def s_polar(qx, qy, qz, P=P, half=half, margin=margin):
                    xx, yy = q_to_xy(qx, qy, qz)
                    v = P.sample_main(xx, yy)
                    out = (np.abs(xx) > half - margin) | (np.abs(yy) > half - margin)
                    return np.where(out, np.nan, v)
                tiers.append((s_polar, rng, P.tier))
                tiers.append((None, rng, "coarse"))     # beyond the square: coarse grid at the same distances
            else:
                tiers.append((None, schedule_main_coarse(), "coarse"))
            return tiers
        # best
        t = self.tile_for(lat, lon)
        if t is not None:
            x, y = ll_to_xy(lat, lon)
            h, w = t.shape
            reach = float(np.hypot(max(x - t.x0, t.x0 + w * t.px - x), max(t.y0 - y, y - (t.y0 - h * t.px))))
            tiers.append((lambda qx, qy, qz, t=t: t.sample(*q_to_xy(qx, qy, qz)), np.arange(1, int(reach / t.px) + 1) * t.px, t.tier))
        if self.r80 is not None:
            tiers.append((lambda qx, qy, qz, r=self.r80: r.sample(*q_to_xy(qx, qy, qz)), np.arange(1, 751) * 80.0, self.r80.tier))
        elif lat <= CAPLAT:
            p = self.p400
            tiers.append((lambda qx, qy, qz, r=p: np.where(r.contains(*q_to_xy(qx, qy, qz)), r.sample(*q_to_xy(qx, qy, qz)), np.nan),
                          schedule_main_400(), p.tier))
        if self.r240 is not None and lat < -59:
            tiers.append((lambda qx, qy, qz, r=self.r240: r.sample(*q_to_xy(qx, qy, qz)), np.arange(1, 1376) * 240.0, self.r240.tier))
        if tiers:
            tiers.append((None, schedule_main_hires(), "coarse"))
        else:
            tiers.append((None, schedule_main_coarse(), "coarse"))
        return tiers

    def _cast(self, lat, lon, heights, naz, mode, ground_m, fast=False) -> HorizonMask:
        az = np.arange(naz) * (360.0 / naz)
        g0 = self.ground(lat, lon, mode) if ground_m is None else float(ground_m)
        if fast:
            def s_any(qx, qy, qz):
                la, lo = q_to_ll(qx, qy, qz)
                return self.elev(la.ravel(), lo.ravel(), mode).reshape(qx.shape)
            tiers = [(s_any, schedule_main_hires(), "fast: finest tier per point")]
        else:
            tiers = self._tiers(lat, lon, mode)
        best = np.full((len(heights), naz), -np.inf)
        covered = np.zeros(naz)           # per azimuth, the range up to which a finer tier had data
        used_tiers = []
        for sampler, ranges, label in tiers:
            qx, qy, qz = ray_points(lat, lon, az, ranges)
            if sampler is None:
                la, lo = q_to_ll(qx, qy, qz)
                h = self.coarse.elev(la, lo)
            else:
                h = sampler(qx, qy, qz)
            valid = np.isfinite(h)
            use = valid & (ranges[None, :] > covered[:, None])
            if not use.any():
                continue
            used_tiers.append("LOLA coarse grid" if label == "coarse" else label)
            # coverage: rays leave a convex raster once, so the last valid range is the limit
            last = np.where(valid.any(axis=1), ranges[np.minimum(valid.shape[1] - 1, valid.shape[1] - 1 - np.argmax(valid[:, ::-1], axis=1))], 0.0)
            covered = np.maximum(covered, np.where(valid.any(axis=1), last, 0.0))
            gr = ranges / R_M
            r1 = R_M + np.where(valid, h, 0.0)
            a = r1 * np.cos(gr)[None, :]
            b = r1 * np.sin(gr)[None, :]
            for k, eye in enumerate(heights):
                el = np.arctan2(a - (R_M + g0 + eye), b)
                el = np.where(use, el, -np.inf).max(axis=1)
                best[k] = np.maximum(best[k], el)
        best = np.where(np.isfinite(best), best, 0.0)
        return HorizonMask(az_deg=az, heights_m=heights, mask_deg=best * R2D, ground_m=g0, tiers=used_tiers, mode=mode, lat=lat, lon=lon)


_default: Terrain | None = None
_dlock = threading.Lock()


def default_terrain() -> Terrain:
    global _default
    with _dlock:
        if _default is None:
            _default = Terrain()
        return _default


def reset_default() -> None:
    global _default
    with _dlock:
        _default = None
