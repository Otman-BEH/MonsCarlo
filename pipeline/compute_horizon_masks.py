#!/usr/bin/env python3
"""
compute_horizon_masks.py

Offline pipeline for the Lunar Landing Site Navigator (NASA Space Apps 2026).
Reads LOLA south polar DEM GeoTIFFs and writes one terrain horizon mask JSON
per landing site, plus index.json.

Usage (PowerShell, from the project folder):
    python pipeline\\compute_horizon_masks.py --inspect
    python pipeline\\compute_horizon_masks.py
    python pipeline\\compute_horizon_masks.py --verify
    python pipeline\\compute_horizon_masks.py --sites connecting_ridge im2_mons_mouton --verify

Conventions
-----------
* Sphere of radius R = 1737400 m, MOON_ME frame, planetocentric latitude,
  east-positive longitude.
* South polar stereographic, lat_0 = -90, lon_0 = 0, k = 1:
      rho = 2 R tan((90 + lat) / 2),  x = rho sin(lon),  y = rho cos(lon)
* Azimuth is clockwise from true north at the site. Rays are built from
  body-fixed unit vectors, so azimuth never depends on the map grid.
* Rasters are pixel-registered: the affine transform refers to the outer
  corner of pixel (0, 0); pixel centres sit at +0.5.

Only numpy, rasterio, scipy and matplotlib are used.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

# --------------------------------------------------------------------------
# Site table (from section 4 of Lunar_Site_Navigator_Technical_Review.md)
# --------------------------------------------------------------------------
# snap: "exact" = landed mission, published coordinates, bilinear elevation.
#       "peak"  = illumination site, highest pixel within --snap-radius of the
#                 nominal point on the finest DEM available.
# tile: name prefix of a 5 m tile in data/dem_sites (file is
#       <tile>_final_adj_5mpp_surf.tif), or None to auto-match any tile that
#       contains the site (this is how LM4 / LM6 / Haworth get picked up).


@dataclass(frozen=True)
class Site:
    site_id: str
    name: str
    lat: float          # degrees, negative south
    lon: float          # degrees east, 0 to 360
    snap: str           # "exact" or "peak"
    tile: str | None = None


SITES: list[Site] = [
    Site("connecting_ridge", "Shackleton-de Gerlache Connecting Ridge", -89.45, 222.7, "peak", "Site01"),
    Site("shackleton_rim", "Shackleton rim", -89.78, 204.27, "peak", None),
    Site("ce7_target", "Peak near Shackleton (Chang'e-7 target)", -88.8, 123.4, "peak", None),
    Site("de_gerlache_rim", "de Gerlache Rim 2", -88.7, 292.0, "peak", None),
    Site("malapert_massif", "Malapert Massif", -86.0, 0.0, "peak", None),
    Site("viper_mons_mouton", "Mons Mouton (VIPER original area)", -85.42, 31.62, "exact", None),
    Site("im2_mons_mouton", "Mons Mouton (IM-2 Athena)", -84.7906, 29.1957, "exact", None),
    Site("im1_malapert_a", "Malapert A (IM-1 Odysseus)", -80.13, 1.44, "exact", None),
    Site("chandrayaan3", "Statio Shiv Shakti (Chandrayaan-3)", -69.373, 32.319, "exact", None),
    # At exactly -90 the local frame is defined by lon = 0: azimuth 0 points along
    # the 0 E meridian, azimuth 90 along 90 E. The front end must use the same
    # lat = -90, lon = 0 when it builds north/east for this site.
    Site("south_pole", "Lunar south pole", -90.0, 0.0, "exact", None),
]
# Skipped on purpose (front end uses a flat horizon): Chang'e-6 (41.64 S,
# 206.01 E), Blue Ghost M1 (18.56 N, 61.81 E), Apollo 11 (0.67 N, 23.47 E).

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------
R_MOON = 1737400.0
SCHEMA_VERSION = 2
N_AZ = 720
AZ_DEG = np.arange(N_AZ) * (360.0 / N_AZ)          # 0.0 ... 359.5
MAST_HEIGHTS_M = [0.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]
REGIONAL_MAX_RANGE_M = 60_000.0
FAR_MAX_RANGE_M = 330_000.0
DEFAULT_SNAP_RADIUS_M = 500.0

TILE_SUFFIX = "_final_adj_5mpp_surf.tif"
REGIONAL_CANDIDATES = ["LDEM_80S_40MPP_ADJ.TIF", "LDEM_80S_80MPP_ADJ.TIF"]   # preference order
FAR_NAME = "LDEM_60S_240MPP_ADJ.TIF"

# Cross-check model parameters (step E4, E5)
SUN_LAT_AMPLITUDE_DEG = 1.54
SUN_DISC_RADIUS_DEG = 0.266
EARTH_LON_HALF_DEG = 7.9
EARTH_LAT_HALF_DEG = 6.7
EARTH_DISC_RADIUS_DEG = 0.95
EARTH_DISTANCE_M = 384_400_000.0

# --------------------------------------------------------------------------
# Logging (stdout plus a log file that is easy to send back)
# --------------------------------------------------------------------------
_LOG_LINES: list[str] = []


def log(msg: str = "") -> None:
    print(msg, flush=True)
    _LOG_LINES.append(msg)


def flush_log(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(_LOG_LINES) + "\n", encoding="utf-8")
        print(f"[log written to {path}]")
    except OSError as exc:
        print(f"[could not write log file: {exc}]")


# --------------------------------------------------------------------------
# Spherical geometry and polar stereographic projection (closed form)
# --------------------------------------------------------------------------
def ll_to_xy(lat_deg, lon_deg):
    """Forward south polar stereographic on the sphere. Arrays or scalars."""
    lat = np.asarray(lat_deg, dtype=np.float64)
    lon = np.radians(np.asarray(lon_deg, dtype=np.float64))
    rho = 2.0 * R_MOON * np.tan(np.radians(90.0 + lat) / 2.0)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_ll(x, y):
    """Inverse south polar stereographic. Returns lat (deg), lon (deg, 0..360)."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    lat = -90.0 + 2.0 * np.degrees(np.arctan(rho / (2.0 * R_MOON)))
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon


def map_scale_factor(lat_deg: float) -> float:
    """Map metres per ground metre at this latitude (k0 = 1 at the pole)."""
    c = math.radians(90.0 + lat_deg)
    return 1.0 / math.cos(c / 2.0) ** 2


def site_frame(lat_deg: float, lon_deg: float):
    """Body-fixed unit vectors at a site: up (p), true north (n), east (e)."""
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    p = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    n = np.array([-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)])
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    return p, n, e


def unit_from_ll(lat_deg, lon_deg):
    la = np.radians(np.asarray(lat_deg, dtype=np.float64))
    lo = np.radians(np.asarray(lon_deg, dtype=np.float64))
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def ray_xy(lat_deg: float, lon_deg: float, az_deg: np.ndarray, ranges_m: np.ndarray):
    """
    Map x/y of points along great circles leaving the site.
    q = p cos g + d sin g, with d = n cos az + e sin az and g = range / R.
    Projection of a unit vector q: x = 2R qy / (1 - qz), y = 2R qx / (1 - qz).
    Returns x, y with shape (n_az, n_range).
    """
    p, n, e = site_frame(lat_deg, lon_deg)
    az = np.radians(az_deg)
    d = np.cos(az)[:, None] * n[None, :] + np.sin(az)[:, None] * e[None, :]     # (n_az, 3)
    g = ranges_m / R_MOON
    cg, sg = np.cos(g)[None, :], np.sin(g)[None, :]
    qx = p[0] * cg + d[:, 0:1] * sg
    qy = p[1] * cg + d[:, 1:2] * sg
    qz = p[2] * cg + d[:, 2:3] * sg
    s = 2.0 * R_MOON / (1.0 - qz)
    return s * qy, s * qx


def destination_point(lat_deg: float, lon_deg: float, bearing_deg: float, dist_m: float):
    """Textbook spherical destination formula. Independent of ray_xy; used by tests."""
    la1, lo1, br = math.radians(lat_deg), math.radians(lon_deg), math.radians(bearing_deg)
    g = dist_m / R_MOON
    la2 = math.asin(math.sin(la1) * math.cos(g) + math.cos(la1) * math.sin(g) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(g) * math.cos(la1),
                           math.cos(g) - math.sin(la1) * math.sin(la2))
    return math.degrees(la2), math.degrees(lo2) % 360.0


# --------------------------------------------------------------------------
# Raster layer
# --------------------------------------------------------------------------
@dataclass
class Grid:
    """In-memory north-up raster. (x0, y0) is the outer corner of pixel (0, 0)."""
    name: str
    data: np.ndarray        # float32, NaN = no data, metres
    x0: float
    y0: float
    px: float               # pixel size in metres (square)

    @property
    def bounds(self):
        h, w = self.data.shape
        return self.x0, self.y0 - h * self.px, self.x0 + w * self.px, self.y0     # xmin, ymin, xmax, ymax

    def sample(self, x, y) -> np.ndarray:
        """Bilinear sample at map coordinates. NaN outside or next to NaN pixels."""
        col = (np.asarray(x) - self.x0) / self.px - 0.5
        row = (self.y0 - np.asarray(y)) / self.px - 0.5
        shape = col.shape
        out = map_coordinates(self.data, [row.ravel(), col.ravel()], order=1,
                              mode="constant", cval=np.nan, output=np.float64, prefilter=False)
        return out.reshape(shape)

    def read_box(self, xmin, ymin, xmax, ymax) -> "Grid":
        return self

    def pixel_centres(self):
        h, w = self.data.shape
        xs = self.x0 + (np.arange(w) + 0.5) * self.px
        ys = self.y0 - (np.arange(h) + 0.5) * self.px
        return xs, ys


class RasterFile:
    """A GeoTIFF on disk with windowed reads. Checks its own georeferencing."""

    def __init__(self, path: Path, kind: str = "dem"):
        import rasterio

        self.path = Path(path)
        self.name = self.path.name
        self.kind = kind
        self.warnings: list[str] = []
        with rasterio.open(self.path) as src:
            t = src.transform
            if abs(t.b) > 1e-9 or abs(t.d) > 1e-9 or t.e >= 0 or t.a <= 0:
                raise ValueError(f"{self.name}: raster is not north-up ({t!r})")
            if abs(t.a + t.e) > 1e-6 * abs(t.a):
                raise ValueError(f"{self.name}: non-square pixels ({t.a}, {t.e})")
            self.width, self.height = src.width, src.height
            self.x0, self.y0, self.px = float(t.c), float(t.f), float(t.a)
            self.nodata = src.nodata
            self.dtype = src.dtypes[0]
            self.scale = float(src.scales[0]) if src.scales and src.scales[0] is not None else 1.0
            self.offset = float(src.offsets[0]) if src.offsets and src.offsets[0] is not None else 0.0
            self.units = src.units[0] if src.units else None
            self.tags = dict(src.tags())
            self.band_tags = dict(src.tags(1))
            self.description = src.descriptions[0] if src.descriptions else None
            self.crs_text = describe_crs(src.crs)
            self.warnings += check_crs(src.crs)
            # Quick decimated look for unit / scaling decisions.
            k = max(1, max(self.width, self.height) // 512)
            dec = src.read(1, out_shape=(max(1, self.height // k), max(1, self.width // k))).astype(np.float64)
            dec = self._clean(dec)
            self.dec_min = float(np.nanmin(dec)) if np.isfinite(dec).any() else float("nan")
            self.dec_max = float(np.nanmax(dec)) if np.isfinite(dec).any() else float("nan")
        self.unit_factor = 1.0
        if kind == "dem":
            unit = (self.units or "").strip().lower()
            if unit in ("km", "kilometer", "kilometre", "kilometers", "kilometres"):
                self.unit_factor = 1000.0
                self.warnings.append("units tag says km: heights multiplied by 1000")
            elif unit not in ("m", "metre", "meter", "metres", "meters") and \
                    np.isfinite(self.dec_max) and max(abs(self.dec_min), abs(self.dec_max)) < 30.0:
                self.unit_factor = 1000.0
                self.warnings.append(
                    f"heights span only {self.dec_min:.3f}..{self.dec_max:.3f} with no metre units tag: "
                    "ASSUMED km and multiplied by 1000")

    @property
    def bounds(self):
        return (self.x0, self.y0 - self.height * self.px, self.x0 + self.width * self.px, self.y0)

    def _clean(self, arr: np.ndarray) -> np.ndarray:
        """nodata to NaN, then GDAL scale/offset. Float in, float out."""
        if self.nodata is not None and not (isinstance(self.nodata, float) and math.isnan(self.nodata)):
            arr[arr == self.nodata] = np.nan
        arr[np.abs(arr) > 1e30] = np.nan              # float-min style fill values
        if self.scale != 1.0 or self.offset != 0.0:
            arr = arr * self.scale + self.offset
        return arr

    def edge_margin(self, x: float, y: float) -> float:
        """Distance (map m) from a point to the nearest raster edge; negative if outside."""
        xmin, ymin, xmax, ymax = self.bounds
        return min(x - xmin, xmax - x, y - ymin, ymax - y)

    def read_box(self, xmin, ymin, xmax, ymax, pad_px: int = 2) -> Grid | None:
        """Windowed read of the pixels covering a map-coordinate box."""
        import rasterio
        from rasterio.windows import Window

        c0 = max(0, int(math.floor((xmin - self.x0) / self.px)) - pad_px)
        c1 = min(self.width, int(math.ceil((xmax - self.x0) / self.px)) + pad_px)
        r0 = max(0, int(math.floor((self.y0 - ymax) / self.px)) - pad_px)
        r1 = min(self.height, int(math.ceil((self.y0 - ymin) / self.px)) + pad_px)
        if c1 <= c0 or r1 <= r0:
            return None
        with rasterio.open(self.path) as src:
            arr = src.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype(np.float32)
        arr = self._clean(arr)
        if self.unit_factor != 1.0:
            arr = arr * np.float32(self.unit_factor)
        return Grid(self.name, np.ascontiguousarray(arr, dtype=np.float32),
                    self.x0 + c0 * self.px, self.y0 - r0 * self.px, self.px)

    def mean_3x3(self, x: float, y: float) -> tuple[float, int]:
        """Mean of the 3 x 3 pixel neighbourhood around the pixel containing (x, y)."""
        import rasterio
        from rasterio.windows import Window

        c = int(math.floor((x - self.x0) / self.px))
        r = int(math.floor((self.y0 - y) / self.px))
        if c < 1 or r < 1 or c > self.width - 2 or r > self.height - 2:
            return float("nan"), 0
        with rasterio.open(self.path) as src:
            arr = src.read(1, window=Window(c - 1, r - 1, 3, 3)).astype(np.float64)
        arr = self._clean(arr)
        n = int(np.isfinite(arr).sum())
        return (float(np.nanmean(arr)) if n else float("nan")), n


def describe_crs(crs) -> str:
    if crs is None:
        return "None"
    try:
        s = crs.to_proj4()
        if s:
            return s
    except Exception:
        pass
    try:
        return crs.to_wkt()[:300]
    except Exception:
        return repr(crs)


def check_crs(crs) -> list[str]:
    """Compare the file CRS with the projection this script assumes. Warn only."""
    if crs is None:
        return ["no CRS in file: ASSUMING south polar stereographic, lon_0 = 0, R = 1737400"]
    try:
        d = crs.to_dict()
    except Exception as exc:
        return [f"could not parse CRS ({exc}): ASSUMING the stated projection"]
    if not d:
        return ["CRS has no PROJ parameters: ASSUMING the stated projection (check WKT in --inspect)"]
    w = []

    def num(key):
        try:
            return float(d[key])
        except (KeyError, TypeError, ValueError):
            return None

    if d.get("proj") not in ("stere", "sterea", "ups"):
        w.append(f"proj = {d.get('proj')!r}, expected 'stere'")
    if num("lat_0") is not None and abs(num("lat_0") + 90.0) > 1e-9:
        w.append(f"lat_0 = {d.get('lat_0')}, expected -90")
    if num("lon_0") is not None and abs(num("lon_0")) > 1e-9:
        w.append(f"lon_0 = {d.get('lon_0')}, expected 0 (azimuths and site positions would be rotated)")
    for key in ("k", "k_0"):
        if num(key) is not None and abs(num(key) - 1.0) > 1e-12:
            w.append(f"{key} = {d.get(key)}, expected 1")
    if num("lat_ts") is not None and abs(num("lat_ts") + 90.0) > 1e-9:
        w.append(f"lat_ts = {d.get('lat_ts')}, expected -90 (true scale at the pole)")
    radius = num("R") if num("R") is not None else num("a")
    if radius is not None and abs(radius - R_MOON) > 0.5:
        w.append(f"sphere radius = {radius}, expected {R_MOON}")
    if num("b") is not None and num("a") is not None and abs(num("a") - num("b")) > 0.5:
        w.append(f"ellipsoid a = {num('a')}, b = {num('b')}; expected a sphere")
    for key in ("x_0", "y_0"):
        if num(key) not in (None, 0.0):
            w.append(f"{key} = {d.get(key)}, expected 0")
    return w


def find_file(folder: Path, name: str) -> Path | None:
    """Case-insensitive file lookup."""
    if not folder.is_dir():
        return None
    for p in folder.iterdir():
        if p.is_file() and p.name.lower() == name.lower():
            return p
    return None


def list_tifs(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in (".tif", ".tiff"))


# --------------------------------------------------------------------------
# Step A: --inspect
# --------------------------------------------------------------------------
def inspect_rasters(data_dir: Path) -> None:
    import rasterio
    from rasterio.windows import Window

    files = list_tifs(data_dir)
    log(f"== INSPECT: {len(files)} rasters under {data_dir} ==")
    for path in files:
        log("")
        log(f"--- {path.relative_to(data_dir)} ---")
        try:
            with rasterio.open(path) as src:
                t = src.transform
                b = src.bounds
                log(f"  size            : {src.width} x {src.height} px, {src.count} band(s), dtype {src.dtypes[0]}")
                log(f"  pixel size      : {t.a:.6f} x {abs(t.e):.6f} m")
                log(f"  bounds (m)      : xmin {b.left:.3f}  ymin {b.bottom:.3f}  xmax {b.right:.3f}  ymax {b.top:.3f}")
                cx, cy = (b.left + b.right) / 2.0, (b.bottom + b.top) / 2.0
                clat, clon = xy_to_ll(cx, cy)
                log(f"  centre          : x {cx:.2f}  y {cy:.2f}  ->  lat {float(clat):.5f}  lon {float(clon):.4f} E")
                edge_lats = [float(xy_to_ll(x, y)[0]) for x, y in
                             ((b.left, cy), (b.right, cy), (cx, b.bottom), (cx, b.top))]
                corner_lats = [float(xy_to_ll(x, y)[0]) for x, y in
                               ((b.left, b.bottom), (b.left, b.top), (b.right, b.bottom), (b.right, b.top))]
                log(f"  edge-mid lats   : {', '.join(f'{v:.4f}' for v in edge_lats)}")
                log(f"  corner lats     : {', '.join(f'{v:.4f}' for v in corner_lats)}")
                log(f"  nodata          : {src.nodata!r}")
                log(f"  scale / offset  : {src.scales[0]!r} / {src.offsets[0]!r}   units: {src.units[0]!r}"
                    f"   description: {src.descriptions[0]!r}")
                log(f"  CRS             : {describe_crs(src.crs)}")
                for w in check_crs(src.crs):
                    log(f"  CRS WARNING     : {w}")
                log(f"  dataset tags    : {dict(src.tags())}")
                log(f"  band 1 tags     : {dict(src.tags(1))}")
                log(f"  compression     : {src.compression}   blocks: {src.block_shapes[0]}")
                # Strip-wise statistics so the big grids never load whole.
                vmin, vmax = math.inf, -math.inf
                n_nan = n_nodata = n_valid = 0
                total = 0.0
                rows = 512
                nod = src.nodata
                for r0 in range(0, src.height, rows):
                    h = min(rows, src.height - r0)
                    a = src.read(1, window=Window(0, r0, src.width, h))
                    if a.dtype.kind == "f":
                        nan_mask = np.isnan(a)
                        n_nan += int(nan_mask.sum())
                        valid = ~nan_mask
                    else:
                        valid = np.ones(a.shape, dtype=bool)
                    if nod is not None and not (isinstance(nod, float) and math.isnan(nod)):
                        nd_mask = a == nod
                        n_nodata += int(nd_mask.sum())
                        valid &= ~nd_mask
                    if valid.any():
                        v = a[valid].astype(np.float64)
                        vmin, vmax = min(vmin, float(v.min())), max(vmax, float(v.max()))
                        total += float(v.sum())
                        n_valid += v.size
                npx = src.width * src.height
                if n_valid:
                    log(f"  min / max / mean: {vmin:.6g} / {vmax:.6g} / {total / n_valid:.6g}  (raw stored values)")
                else:
                    log("  min / max       : no valid pixels")
                log(f"  NaN count       : {n_nan}   nodata-valued count: {n_nodata}   valid: {n_valid} of {npx}")
                inside = []
                for s in SITES:
                    sx, sy = ll_to_xy(s.lat, s.lon)
                    m = min(float(sx) - b.left, b.right - float(sx), float(sy) - b.bottom, b.top - float(sy))
                    if m > 0:
                        inside.append(f"{s.site_id} ({m / 1000.0:.2f} km from edge)")
                log(f"  table sites in  : {', '.join(inside) if inside else 'none'}")
        except Exception as exc:  # keep going so one bad file does not hide the rest
            log(f"  ERROR reading file: {type(exc).__name__}: {exc}")


# --------------------------------------------------------------------------
# Step C: ray casting
# --------------------------------------------------------------------------
@dataclass
class Tier:
    source: object          # Grid or RasterFile (anything with read_box, px, name)
    role: str               # "site_tile", "regional" or "far"
    step_m: float
    max_range_m: float


@dataclass
class HorizonResult:
    elevation_deg: np.ndarray       # (n_mast, n_az)
    distance_m: np.ndarray          # (n_mast, n_az)
    tier_of_max: np.ndarray         # (n_mast, n_az) index into tiers, -1 if none
    n_samples: int = 0
    n_empty_rays: int = 0


def cast_horizon(lat_deg: float, lon_deg: float, ground_m: float, tiers: list[Tier],
                 masts_m=MAST_HEIGHTS_M, az_deg: np.ndarray = AZ_DEG) -> HorizonResult:
    """
    Horizon elevation per azimuth for every mast height from one set of terrain
    samples. Tiers are ordered fine to coarse. A coarser sample counts only
    where every finer tier has no valid sample at that range (ray left the
    raster or hit NaN), which implements the fall-through.
    """
    n_az, n_m = len(az_deg), len(masts_m)
    best = np.full((n_m, n_az), -np.inf)
    best_d = np.zeros((n_m, n_az))
    best_t = np.full((n_m, n_az), -1, dtype=np.int16)
    rows = np.arange(n_az)
    finer: list[tuple[float, np.ndarray]] = []       # (step, valid mask) of finer tiers
    n_samples = 0

    for ti, tier in enumerate(tiers):
        n = int(math.floor(tier.max_range_m / tier.step_m + 1e-9))
        if n < 1:
            finer.append((tier.step_m, np.zeros((n_az, 0), dtype=bool)))
            continue
        ranges = tier.step_m * np.arange(1, n + 1, dtype=np.float64)     # starts at one pixel
        x, y = ray_xy(lat_deg, lon_deg, az_deg, ranges)
        grid = tier.source.read_box(float(x.min()), float(y.min()), float(x.max()), float(y.max()))
        if grid is None:
            finer.append((tier.step_m, np.zeros((n_az, n), dtype=bool)))
            continue
        h = grid.sample(x, y)
        del x, y
        valid = np.isfinite(h)
        used = valid.copy()
        for f_step, f_valid in finer:
            if f_valid.shape[1] == 0:
                continue
            idx = np.rint(ranges / f_step).astype(np.int64) - 1
            inside = (idx >= 0) & (idx < f_valid.shape[1])
            if inside.any():
                covered = np.zeros_like(used)
                covered[:, inside] = f_valid[:, idx[inside]]
                used &= ~covered
        finer.append((tier.step_m, valid))
        n_samples += int(used.sum())
        if not used.any():
            continue

        g = ranges / R_MOON
        r1 = R_MOON + np.where(valid, h, 0.0)
        a = r1 * np.cos(g)[None, :]          # r1 cos g
        b = r1 * np.sin(g)[None, :]          # r1 sin g
        del h, r1
        for mi, mast in enumerate(masts_m):
            r0 = R_MOON + ground_m + mast
            el = np.arctan2(a - r0, b)
            el[~used] = -np.inf
            j = np.argmax(el, axis=1)
            val = el[rows, j]
            upd = val > best[mi]
            best[mi, upd] = val[upd]
            best_d[mi, upd] = ranges[j[upd]]
            best_t[mi, upd] = ti

    empty = ~np.isfinite(best)
    n_empty = int(empty[0].sum())
    if empty.any():
        # No terrain sample at all on this ray: fall back to the smooth sphere dip.
        for mi, mast in enumerate(masts_m):
            r0 = R_MOON + ground_m + mast
            dip = -math.acos(min(1.0, R_MOON / r0)) if r0 > R_MOON else 0.0
            best[mi, empty[mi]] = dip
    return HorizonResult(np.degrees(best), best_d, best_t, n_samples, n_empty)


# --------------------------------------------------------------------------
# Step B: site snapping and DEM selection
# --------------------------------------------------------------------------
@dataclass
class DemSet:
    tiles: dict[str, RasterFile] = field(default_factory=dict)
    regional: RasterFile | None = None
    far: RasterFile | None = None


def load_dem_set(data_dir: Path) -> DemSet:
    ds = DemSet()
    tile_dir = data_dir / "dem_sites"
    if tile_dir.is_dir():
        for p in sorted(tile_dir.iterdir()):
            if p.is_file() and p.name.lower().endswith(TILE_SUFFIX):
                ds.tiles[p.name[: -len(TILE_SUFFIX)]] = RasterFile(p)
    reg_dir = data_dir / "dem_regional"
    for cand in REGIONAL_CANDIDATES:
        p = find_file(reg_dir, cand)
        if p is not None:
            ds.regional = RasterFile(p)
            break
    p = find_file(reg_dir, FAR_NAME)
    if p is not None:
        ds.far = RasterFile(p)
    log("== DEM sources ==")
    for label, rf in [(f"tile {k}", v) for k, v in ds.tiles.items()] + \
                     [("regional", ds.regional), ("far", ds.far)]:
        if rf is None:
            log(f"  {label:14s}: MISSING")
            continue
        xmin, ymin, xmax, ymax = rf.bounds
        clat, clon = xy_to_ll((xmin + xmax) / 2, (ymin + ymax) / 2)
        log(f"  {label:14s}: {rf.name}  {rf.width} x {rf.height} @ {rf.px:g} m  "
            f"centre {float(clat):.4f}, {float(clon):.3f} E  nodata {rf.nodata!r}  "
            f"sampled range {rf.dec_min:.1f}..{rf.dec_max:.1f}  unit factor {rf.unit_factor:g}")
        for w in rf.warnings:
            log(f"      WARNING: {w}")
    if ds.regional is None and ds.far is None:
        raise FileNotFoundError(f"no regional DEM found in {reg_dir}")
    return ds


def choose_tile(site: Site, ds: DemSet, margin_m: float) -> tuple[RasterFile | None, str]:
    x, y = (float(v) for v in ll_to_xy(site.lat, site.lon))
    if site.tile is not None:
        rf = ds.tiles.get(site.tile)
        if rf is None:
            return None, f"tile '{site.tile}' named in the table was not found"
        m = rf.edge_margin(x, y)
        if m < margin_m:
            return None, (f"tile '{site.tile}' does not contain the nominal point with {margin_m:.0f} m margin "
                          f"(edge margin {m:.0f} m): NOT USED")
        return rf, f"tile '{site.tile}' from the table (edge margin {m / 1000:.2f} km)"
    best, best_m = None, margin_m
    for rf in ds.tiles.values():
        m = rf.edge_margin(x, y)
        if m >= best_m:
            best, best_m = rf, m
    if best is None:
        return None, "no 5 m tile contains this site"
    return best, f"tile '{best.name}' auto-matched (edge margin {best_m / 1000:.2f} km)"


def snap_site(site: Site, sources: list, radius_m: float):
    """Returns (lat, lon, elevation, source_name, note)."""
    x, y = (float(v) for v in ll_to_xy(site.lat, site.lon))
    k = map_scale_factor(site.lat)
    for src in sources:
        if site.snap == "exact":
            g = src.read_box(x - 3 * src.px, y - 3 * src.px, x + 3 * src.px, y + 3 * src.px)
            if g is None:
                continue
            h = float(g.sample(np.array([x]), np.array([y]))[0])
            if math.isfinite(h):
                return site.lat, site.lon % 360.0, h, src.name, "published coordinates, bilinear elevation"
        elif site.snap == "peak":
            rm = radius_m * k + 2 * src.px
            g = src.read_box(x - rm, y - rm, x + rm, y + rm)
            if g is None:
                continue
            xs, ys = g.pixel_centres()
            dist = np.hypot(xs[None, :] - x, ys[:, None] - y) / k
            cand = np.where((dist <= radius_m) & np.isfinite(g.data), g.data, -np.inf)
            if not np.isfinite(cand).any():
                continue
            i, j = np.unravel_index(int(np.argmax(cand)), cand.shape)
            lat, lon = xy_to_ll(xs[j], ys[i])
            moved = float(dist[i, j])
            at_edge = moved > radius_m - 1.5 * src.px
            note = f"highest pixel within {radius_m:.0f} m, moved {moved:.0f} m"
            if at_edge:
                note += " (AT THE EDGE of the search disc: the true summit is probably farther away)"
            return float(lat), float(lon), float(g.data[i, j]), src.name, note
        else:
            raise ValueError(f"unknown snap mode {site.snap!r}")
    raise RuntimeError(f"{site.site_id}: no DEM has valid data at the nominal point")


def process_site(site: Site, ds: DemSet, snap_radius_m: float) -> dict:
    t0 = time.perf_counter()
    log("")
    log(f"== {site.site_id}: {site.name} ==")
    margin = snap_radius_m + 50.0 if site.snap == "peak" else 50.0
    tile, tile_note = choose_tile(site, ds, margin)
    log(f"  5 m tile        : {tile_note}")

    sources = [s for s in (tile, ds.regional, ds.far) if s is not None]
    lat, lon, ground, snap_src, snap_note = snap_site(site, sources, snap_radius_m)
    log(f"  nominal         : lat {site.lat:.5f}  lon {site.lon % 360.0:.5f} E")
    log(f"  snapped ({site.snap:5s}) : lat {lat:.5f}  lon {lon:.5f} E  elevation {ground:.2f} m  "
        f"[{snap_src}] {snap_note}")
    x, y = (float(v) for v in ll_to_xy(lat, lon))
    k = map_scale_factor(lat)

    tiers: list[Tier] = []
    if tile is not None:
        xmin, ymin, xmax, ymax = tile.bounds
        far_corner = max(math.hypot(cx - x, cy - y) for cx in (xmin, xmax) for cy in (ymin, ymax))
        tiers.append(Tier(tile, "site_tile", tile.px, far_corner / min(1.0, k) + tile.px))
    if ds.regional is not None:
        tiers.append(Tier(ds.regional, "regional", ds.regional.px, REGIONAL_MAX_RANGE_M))
    if ds.far is not None:
        tiers.append(Tier(ds.far, "far", ds.far.px, FAR_MAX_RANGE_M))

    res = cast_horizon(lat, lon, ground, tiers)
    dt = time.perf_counter() - t0

    dem_sources = []
    for ti, tier in enumerate(tiers):
        count = int((res.tier_of_max[0] == ti).sum())
        dem_sources.append({
            "file": tier.source.name,
            "role": tier.role,
            "pixel_size_m": tier.source.px,
            "max_range_m": round(tier.max_range_m),
            "horizon_azimuth_count": count,
        })
        log(f"  tier {ti} {tier.role:9s}: {tier.source.name}  step {tier.step_m:g} m  to {tier.max_range_m / 1000:.1f} km  "
            f"sets the 0 m horizon on {count} of {N_AZ} azimuths")
    if res.n_empty_rays:
        log(f"  WARNING: {res.n_empty_rays} azimuths had no terrain sample at all; smooth sphere dip used there")
    for mi, mast in enumerate(MAST_HEIGHTS_M):
        e, d = res.elevation_deg[mi], res.distance_m[mi]
        log(f"  mast {mast:4.0f} m     : horizon min {e.min():8.4f}  mean {e.mean():8.4f}  max {e.max():8.4f} deg "
            f"(max at az {AZ_DEG[int(e.argmax())]:5.1f}, {d[int(e.argmax())] / 1000:.2f} km);  "
            f"distance median {np.median(d) / 1000:.2f} km  max {d.max() / 1000:.1f} km")
    log(f"  samples used    : {res.n_samples:,}   time {dt:.1f} s")

    return {
        "schema_version": SCHEMA_VERSION,
        "site_id": site.site_id,
        "site_name": site.name,
        "lat": round(lat, 6),
        "lon": round(lon % 360.0, 6),
        "elevation_m": round(ground, 2),
        "snap_mode": site.snap,
        "nominal_lat": site.lat,
        "nominal_lon": site.lon % 360.0,
        "frame": "MOON_ME",
        "radius_m": R_MOON,
        "dem_sources": dem_sources,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "azimuth_deg": [round(float(a), 1) for a in AZ_DEG],
        "masks": [
            {
                "mast_height_m": mast,
                "horizon_elevation_deg": [round(float(v), 4) for v in res.elevation_deg[mi]],
                "horizon_distance_m": [int(round(float(v))) for v in res.distance_m[mi]],
            }
            for mi, mast in enumerate(MAST_HEIGHTS_M)
        ],
    }


# --------------------------------------------------------------------------
# Step D: output
# --------------------------------------------------------------------------
def write_site_json(out_dir: Path, doc: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{doc['site_id']}.json"
    path.write_text(json.dumps(doc, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    return path


def write_index(out_dir: Path) -> Path:
    """Rebuild index.json from every site file present, in table order."""
    entries = []
    for site in SITES:
        p = out_dir / f"{site.site_id}.json"
        if not p.is_file():
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        entries.append({
            "site_id": d["site_id"],
            "site_name": d["site_name"],
            "lat": d["lat"],
            "lon": d["lon"],
            "elevation_m": d["elevation_m"],
            "snap_mode": d["snap_mode"],
            "file": p.name,
        })
    index = {
        "schema_version": SCHEMA_VERSION,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "frame": "MOON_ME",
        "radius_m": R_MOON,
        "mast_heights_m": MAST_HEIGHTS_M,
        "sites": entries,
    }
    path = out_dir / "index.json"
    path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# Step E: verification
# --------------------------------------------------------------------------
def _synthetic_grid(name: str, cx: float, cy: float, half_m: float, px: float) -> Grid:
    n = int(round(2 * half_m / px))
    return Grid(name, np.zeros((n, n), dtype=np.float32), cx - half_m, cy + half_m, px)


def verify_flat_sphere() -> None:
    """E1: zero-height DEM; horizon must equal -acos(R / (R + h)) at every azimuth."""
    log("")
    log("== VERIFY 1: flat sphere ==")
    lat, lon = -89.0, 45.0
    x, y = (float(v) for v in ll_to_xy(lat, lon))
    tiers = [
        Tier(_synthetic_grid("flat_80m", x, y, 62_000.0, 80.0), "regional", 80.0, REGIONAL_MAX_RANGE_M),
        Tier(_synthetic_grid("flat_240m", x, y, 204_000.0, 240.0), "far", 240.0, FAR_MAX_RANGE_M),
    ]
    masts = [10.0, 1000.0]
    res = cast_horizon(lat, lon, 0.0, tiers, masts_m=masts)
    for mi, h in enumerate(masts):
        expect = -math.degrees(math.acos(R_MOON / (R_MOON + h)))
        err = float(np.abs(res.elevation_deg[mi] - expect).max())
        d_expect = R_MOON * math.acos(R_MOON / (R_MOON + h))
        d = res.distance_m[mi]
        log(f"  mast {h:6.0f} m: expected {expect:.6f} deg, got {res.elevation_deg[mi].min():.6f}.."
            f"{res.elevation_deg[mi].max():.6f}, max abs error {err:.2e} deg;  "
            f"tangent range expected {d_expect:.0f} m, got {d.min():.0f}..{d.max():.0f} m")
        assert err < 0.001, f"flat sphere test failed for mast {h} m: error {err} deg"
    log("  PASS")


def verify_orientation() -> None:
    """E2: one Gaussian peak 10 km due north, then due east, of 89 S, 45 E."""
    log("")
    log("== VERIFY 2: orientation ==")
    lat, lon = -89.0, 45.0
    x, y = (float(v) for v in ll_to_xy(lat, lon))
    rho_site = math.hypot(x, y)
    step = 360.0 / N_AZ
    cases = [("north", 0.0), ("east", 90.0)]
    for label, bearing in cases:
        if label == "north":
            # Due north along the meridian: same longitude, latitude closer to the equator.
            plat, plon = lat + math.degrees(10_000.0 / R_MOON), lon
        else:
            plat, plon = destination_point(lat, lon, 90.0, 10_000.0)
        px_, py_ = (float(v) for v in ll_to_xy(plat, plon))
        g = _synthetic_grid(f"peak_{label}", x, y, 62_000.0, 80.0)
        xs, ys = g.pixel_centres()
        g.data[:] = (3000.0 * np.exp(-((xs[None, :] - px_) ** 2 + (ys[:, None] - py_) ** 2)
                                     / (2.0 * 1500.0 ** 2))).astype(np.float32)
        ground = float(g.sample(np.array([x]), np.array([y]))[0])
        res = cast_horizon(lat, lon, ground, [Tier(g, "regional", 80.0, REGIONAL_MAX_RANGE_M)], masts_m=[2.0])
        az_max = float(AZ_DEG[int(np.argmax(res.elevation_deg[0]))])
        diff = abs((az_max - bearing + 180.0) % 360.0 - 180.0)
        log(f"  peak 10 km due {label:5s}: at lat {plat:.4f}, lon {plon:.4f} E, map x {px_:.0f}, y {py_:.0f};  "
            f"mask maximum {res.elevation_deg[0].max():.3f} deg at azimuth {az_max:.1f} "
            f"(expected {bearing:.1f}), range {res.distance_m[0][int(np.argmax(res.elevation_deg[0]))]:.0f} m")
        assert diff <= step + 1e-9, f"orientation test failed: peak due {label} found at azimuth {az_max}"
        if label == "north":
            assert math.hypot(px_, py_) > rho_site, "north is not radially outward from the map origin"
            log(f"  north is radially outward: rho {rho_site:.0f} m -> {math.hypot(px_, py_):.0f} m")
        else:
            # East is to the right when facing north from above: check with a cross product in map space.
            ux, uy = x / rho_site, y / rho_site                       # outward = north
            ex, ey = px_ - x, py_ - y
            cross = ux * ey - uy * ex                                 # z of north x east (map x right, y up)
            log(f"  east offset in map: dx {ex:.0f} m, dy {ey:.0f} m; north x east z = {cross:.0f} "
                "(negative means east is clockwise from north on the map as drawn, x right and y up)")
    log("  PASS")


def disc_fraction(el_centre_deg, horizon_deg, radius_deg):
    """Visible fraction of a disc above a locally straight horizon (chord formula)."""
    xr = np.clip((el_centre_deg - horizon_deg) / radius_deg, -1.0, 1.0)
    return 0.5 + (xr * np.sqrt(1.0 - xr * xr) + np.arcsin(xr)) / math.pi


def model_sun_fraction(lat, lon, hor_deg) -> float:
    """E4 model: sub-solar longitude uniform, latitude 1.54 deg sinusoid, mean visible disc fraction."""
    p, n, e = site_frame(lat, lon)
    sl = np.radians(np.arange(0.0, 360.0, 0.25))[:, None]
    ph = np.linspace(0.0, 2.0 * math.pi, 720, endpoint=False)[None, :]
    sb = np.radians(SUN_LAT_AMPLITUDE_DEG * np.sin(ph))
    s = np.stack([np.cos(sb) * np.cos(sl), np.cos(sb) * np.sin(sl), np.sin(sb) * np.ones_like(sl)], axis=-1)
    el = np.degrees(np.arcsin(np.clip(s @ p, -1.0, 1.0)))
    az = np.degrees(np.arctan2(s @ e, s @ n)) % 360.0
    hz = np.interp(az, AZ_DEG, hor_deg, period=360.0)
    return float(disc_fraction(el, hz, SUN_DISC_RADIUS_DEG).mean())


def model_earth_fraction(lat, lon, ground, mast, hor_deg) -> float:
    """E5 model: sub-Earth point uniform over a libration box, parallax by vector subtraction."""
    p, n, e = site_frame(lat, lon)
    el_ = np.radians(np.arange(-EARTH_LON_HALF_DEG, EARTH_LON_HALF_DEG + 1e-9, 0.1))[:, None]
    eb = np.radians(np.arange(-EARTH_LAT_HALF_DEG, EARTH_LAT_HALF_DEG + 1e-9, 0.1))[None, :]
    u = np.stack([np.cos(eb) * np.cos(el_), np.cos(eb) * np.sin(el_), np.sin(eb) * np.ones_like(el_)], axis=-1)
    v = EARTH_DISTANCE_M * u - (R_MOON + ground + mast) * p
    v /= np.linalg.norm(v, axis=-1, keepdims=True)
    el = np.degrees(np.arcsin(np.clip(v @ p, -1.0, 1.0)))
    az = np.degrees(np.arctan2(v @ e, v @ n)) % 360.0
    hz = np.interp(az, AZ_DEG, hor_deg, period=360.0)
    return float(disc_fraction(el, hz, EARTH_DISC_RADIUS_DEG).mean())


def describe_visibility_raster(rf: RasterFile) -> tuple[float, str]:
    """Decide how to turn stored values into a 0..1 fraction. Returns (divisor, explanation)."""
    lo, hi = rf.dec_min, rf.dec_max
    base = (f"dtype {rf.dtype}, nodata {rf.nodata!r}, GDAL scale {rf.scale:g}, offset {rf.offset:g}, "
            f"units {rf.units!r}, description {rf.description!r}, tags {rf.tags}, band tags {rf.band_tags}, "
            f"decimated value range after scale/offset {lo:.4g}..{hi:.4g}")
    if not math.isfinite(hi):
        return float("nan"), base + " -> no valid values, cannot interpret"
    if hi <= 1.0001:
        return 1.0, base + " -> read as a FRACTION 0..1"
    if hi <= 100.01:
        return 100.0, base + " -> read as PERCENT, divided by 100"
    if rf.dtype == "uint8" and hi <= 255:
        return 255.0, base + " -> uint8 above 100: GUESSED 0..255 full scale, divided by 255"
    return float("nan"), base + " -> scaling NOT RECOGNISED, raw values reported, no difference computed"


def cross_checks(data_dir: Path, docs: list[dict]) -> None:
    illum = data_dir / "illumination"
    files = [p for p in list_tifs(illum) if p.name.upper().startswith("AVGVISIB")]
    sun_maps, earth_maps = [], []
    for p in files:
        try:
            rf = RasterFile(p, kind="visibility")
        except Exception as exc:
            log(f"  could not open {p.name}: {exc}")
            continue
        (earth_maps if "EARTH" in p.stem.upper() else sun_maps).append(rf)
    sun_maps.sort(key=lambda r: r.px)
    earth_maps.sort(key=lambda r: r.px)

    for title, maps, which in (("VERIFY 4: solar cross-check (report only)", sun_maps, "sun"),
                               ("VERIFY 5: Earth cross-check (report only)", earth_maps, "earth")):
        log("")
        log(f"== {title} ==")
        if not maps:
            log("  no AVGVISIB raster found for this check")
            continue
        scaling = {}
        for rf in maps:
            div, text = describe_visibility_raster(rf)
            scaling[rf.name] = div
            log(f"  {rf.name}: {rf.width} x {rf.height} @ {rf.px:g} m")
            log(f"      {text}")
            for w in rf.warnings:
                log(f"      WARNING: {w}")
        log("  model = mean visible disc fraction, in percent. diff = model(0 m) - map.")
        log(f"  {'site':18s} {'model 0 m':>10s} {'model 2 m':>10s} {'model 10 m':>11s} {'map':>8s} {'diff':>8s}  map file (valid px of 9, raw mean)")
        for d in docs:
            lat, lon, ground = d["lat"], d["lon"], d["elevation_m"]
            by_mast = {m["mast_height_m"]: np.array(m["horizon_elevation_deg"]) for m in d["masks"]}
            vals = []
            for mast in (0.0, 2.0, 10.0):
                if which == "sun":
                    vals.append(100.0 * model_sun_fraction(lat, lon, by_mast[mast]))
                else:
                    vals.append(100.0 * model_earth_fraction(lat, lon, ground, mast, by_mast[mast]))
            x, y = (float(v) for v in ll_to_xy(lat, lon))
            found = None
            for rf in maps:
                raw, nvalid = rf.mean_3x3(x, y)
                if nvalid:
                    found = (rf, raw, nvalid)
                    break
            if found is None:
                log(f"  {d['site_id']:18s} {vals[0]:10.2f} {vals[1]:10.2f} {vals[2]:11.2f} {'n/a':>8s} {'n/a':>8s}  outside every map")
                continue
            rf, raw, nvalid = found
            div = scaling[rf.name]
            if math.isfinite(div):
                mp = 100.0 * raw / div
                log(f"  {d['site_id']:18s} {vals[0]:10.2f} {vals[1]:10.2f} {vals[2]:11.2f} {mp:8.2f} {vals[0] - mp:+8.2f}  "
                    f"{rf.name} ({nvalid}, {raw:.5g})")
            else:
                log(f"  {d['site_id']:18s} {vals[0]:10.2f} {vals[1]:10.2f} {vals[2]:11.2f} {'?':>8s} {'?':>8s}  "
                    f"{rf.name} ({nvalid}, raw {raw:.5g})")


def make_plots(plot_dir: Path, docs: list[dict]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LogNorm

    plot_dir.mkdir(parents=True, exist_ok=True)
    az = AZ_DEG
    upper = [m for m in MAST_HEIGHTS_M if m > 0]
    cmap = matplotlib.colormaps["autumn_r"]
    line_colours = {m: cmap(0.15 + 0.85 * i / max(1, len(upper) - 1)) for i, m in enumerate(upper)}
    for d in docs:
        masks = {m["mast_height_m"]: (np.array(m["horizon_elevation_deg"]),
                                      np.array(m["horizon_distance_m"], dtype=float)) for m in d["masks"]}
        e0, d0 = masks[0.0]
        dist_km = np.maximum(d0, 1.0) / 1000.0
        norm = LogNorm(vmin=max(0.005, float(dist_km.min())), vmax=max(1.0, float(dist_km.max())))
        title = (f"{d['site_name']}\nlat {d['lat']:.4f}, lon {d['lon']:.4f} E, "
                 f"elevation {d['elevation_m']:.0f} m ({d['snap_mode']})")

        fig, ax = plt.subplots(figsize=(13, 5))
        ax.plot(az, e0, color="0.6", lw=0.6, zorder=1)
        sc = ax.scatter(az, e0, c=dist_km, cmap="viridis", norm=norm, s=7, zorder=3, label="mast 0 m (coloured by distance)")
        for mast, col in line_colours.items():
            ax.plot(az, masks[mast][0], color=col, lw=0.9, zorder=2, label=f"mast {mast:g} m")
        ax.axhline(0.0, color="k", lw=0.5, ls=":")
        ax.axhspan(-SUN_LAT_AMPLITUDE_DEG - SUN_DISC_RADIUS_DEG - (90 + d["lat"]),
                   SUN_LAT_AMPLITUDE_DEG + SUN_DISC_RADIUS_DEG + (90 + d["lat"]),
                   color="gold", alpha=0.12, lw=0, label="band the Sun can occupy")
        ax.set_xlim(0, 360)
        ax.set_xticks(np.arange(0, 361, 45))
        ax.set_xticklabels(["N", "45", "E", "135", "S", "225", "W", "315", "N"])
        ax.set_xlabel("azimuth, degrees clockwise from true north")
        ax.set_ylabel("horizon elevation (deg)")
        ax.set_title(title, fontsize=10)
        ax.grid(alpha=0.3)
        ax.legend(fontsize=7, loc="upper right", ncol=4)
        fig.colorbar(sc, ax=ax, label="distance to horizon point, mast 0 m (km)", pad=0.01)
        fig.tight_layout()
        fig.savefig(plot_dir / f"{d['site_id']}_panorama.png", dpi=130)
        plt.close(fig)

        fig = plt.figure(figsize=(7.5, 7.5))
        ax = fig.add_subplot(111, projection="polar")
        ax.set_theta_zero_location("N")
        ax.set_theta_direction(-1)
        th = np.radians(az)
        all_e = np.concatenate([m[0] for m in masks.values()])
        rmin = math.floor(float(all_e.min())) - 1.0
        rmax = math.ceil(float(all_e.max())) + 0.5
        for mast, col in line_colours.items():
            ax.plot(np.append(th, th[0]), np.append(masks[mast][0], masks[mast][0][0]), color=col, lw=0.9,
                    label=f"mast {mast:g} m")
        sc = ax.scatter(th, e0, c=dist_km, cmap="viridis", norm=norm, s=6, zorder=3, label="mast 0 m")
        ax.plot(np.linspace(0, 2 * math.pi, 361), np.zeros(361), color="k", lw=0.6, ls=":")
        ax.set_ylim(rmin, rmax)
        ax.set_title(title + "\nradius = horizon elevation (deg), north up, east right", fontsize=9)
        ax.legend(fontsize=7, loc="lower left", bbox_to_anchor=(-0.12, -0.08))
        fig.colorbar(sc, ax=ax, label="distance (km)", shrink=0.7, pad=0.08)
        fig.tight_layout()
        fig.savefig(plot_dir / f"{d['site_id']}_polar.png", dpi=130)
        plt.close(fig)
    log(f"  plots written to {plot_dir} ({2 * len(docs)} files)")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def default_base_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here, *here.parents):
        if (cand / "data").is_dir():
            return cand
    return here.parent


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Compute terrain horizon masks for lunar south pole sites.")
    ap.add_argument("--base-dir", type=Path, default=default_base_dir(),
                    help="project folder containing Data (default: nearest parent of this script that has Data)")
    ap.add_argument("--sites", nargs="*", default=None, metavar="SITE_ID",
                    help="site ids to process (default: all). Known: " + ", ".join(s.site_id for s in SITES))
    ap.add_argument("--verify", action="store_true", help="run synthetic asserts, plots and cross-checks")
    ap.add_argument("--inspect", action="store_true", help="print metadata and statistics for every raster, then exit")
    ap.add_argument("--snap-radius", type=float, default=DEFAULT_SNAP_RADIUS_M,
                    help="search radius in metres for 'peak' sites (default 500)")
    args = ap.parse_args(argv)

    base = args.base_dir.expanduser().resolve()
    data_dir = base / "data"
    out_dir = data_dir / "horizon_masks"
    log(f"compute_horizon_masks.py  schema {SCHEMA_VERSION}  {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    log(f"base dir: {base}")
    log(f"python {sys.version.split()[0]}, numpy {np.__version__}")
    status = 0
    try:
        if args.inspect:
            if not data_dir.is_dir():
                raise FileNotFoundError(f"Data folder not found: {data_dir}")
            inspect_rasters(data_dir)
            flush_log(out_dir / "inspect_log.txt")
            return 0

        if args.verify:
            verify_flat_sphere()
            verify_orientation()

        if not data_dir.is_dir():
            raise FileNotFoundError(f"Data folder not found: {data_dir}")
        known = {s.site_id: s for s in SITES}
        if args.sites:
            unknown = [s for s in args.sites if s not in known]
            if unknown:
                raise SystemExit(f"unknown site id(s): {unknown}. Known: {list(known)}")
            todo = [known[s] for s in args.sites]
        else:
            todo = list(SITES)

        log("")
        ds = load_dem_set(data_dir)
        docs = []
        t_all = time.perf_counter()
        for site in todo:
            try:
                doc = process_site(site, ds, args.snap_radius)
            except Exception as exc:
                log(f"  ERROR for {site.site_id}: {type(exc).__name__}: {exc}")
                status = 1
                continue
            path = write_site_json(out_dir, doc)
            log(f"  wrote {path}  ({path.stat().st_size / 1024:.0f} kB)")
            docs.append(doc)
        idx = write_index(out_dir)
        log("")
        log(f"wrote {idx}   total time {time.perf_counter() - t_all:.1f} s")

        if args.verify and docs:
            log("")
            log("== VERIFY 3: panorama plots ==")
            make_plots(out_dir / "plots", docs)
            cross_checks(data_dir, docs)
    except AssertionError as exc:
        log(f"VERIFY FAILED: {exc}")
        status = 2
    finally:
        flush_log(out_dir / "run_log.txt")
    return status


if __name__ == "__main__":
    sys.exit(main())
