"""SPICE fallback (and validation) for Sun and Earth vectors in the Moon-fixed frame.

Kernels from raw/kernels/ (NAIF generic kernels, DE440). spkpos(target, et, 'MOON_ME', 'LT+S', 'MOON').
CSPICE is not thread-safe, so every call holds one lock.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone

import numpy as np

from .. import config

KERNELS = ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_220930.tf"]
SOURCE = "spice-de440"
_lock = threading.Lock()
_loaded = False


def available() -> bool:
    return all((config.RAW_DIR / "kernels" / k).exists() for k in KERNELS)


def _load():
    global _loaded
    if _loaded:
        return
    import spiceypy as sp
    missing = [k for k in KERNELS if not (config.RAW_DIR / "kernels" / k).exists()]
    if missing:
        raise FileNotFoundError("SPICE kernels missing: " + ", ".join(missing))
    for k in KERNELS:
        sp.furnsh(str(config.RAW_DIR / "kernels" / k))
    _loaded = True


def unix_to_et(t_unix: np.ndarray) -> np.ndarray:
    """UTC unix seconds to ephemeris time, via the leap-second kernel (str2et on the first epoch, then offsets).
    Valid while no leap second falls inside the span (none since 2017)."""
    import spiceypy as sp
    t = np.asarray(t_unix, dtype=np.float64)
    iso = datetime.fromtimestamp(float(t.flat[0]), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    et0 = sp.str2et(iso + " UTC")
    return et0 + (t - t.flat[0])


def vectors(t_unix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sun and Earth positions (km) from the Moon's centre in MOON_ME, shape (n, 3) each."""
    import spiceypy as sp
    with _lock:
        _load()
        et = unix_to_et(t_unix)
        s, _ = sp.spkpos("SUN", et, "MOON_ME", "LT+S", "MOON")
        e, _ = sp.spkpos("EARTH", et, "MOON_ME", "LT+S", "MOON")
    return np.asarray(s, dtype=np.float64).reshape(-1, 3), np.asarray(e, dtype=np.float64).reshape(-1, 3)


# Deep Space Network complexes (main's src/engine.js DSN list), geodetic degrees and metres
DSN = [("Goldstone", 35.4267, -116.8900, 900.0), ("Madrid", 40.4314, -4.2481, 900.0), ("Canberra", -35.4014, 148.9817, 900.0)]


def dsn_view(t_unix: float) -> list[dict]:
    """Elevation of the Moon's centre at each DSN complex at one instant (see dsn_azel)."""
    az, el = dsn_azel(np.array([float(t_unix)]))
    return [{"name": d[0], "azimuth_deg": float(az[k, 0]), "elevation_deg": float(el[k, 0])} for k, d in enumerate(DSN)]


_AS = np.pi / 180 / 3600
J2000_UNIX = 946728000.0          # 2000-01-01T12:00:00 UTC


def _rz(a):
    c, s, o, i = np.cos(a), np.sin(a), np.zeros_like(a), np.ones_like(a)
    return np.stack([np.stack([c, s, o], -1), np.stack([-s, c, o], -1), np.stack([o, o, i], -1)], -2)


def _ry(a):
    c, s, o, i = np.cos(a), np.sin(a), np.zeros_like(a), np.ones_like(a)
    return np.stack([np.stack([c, o, -s], -1), np.stack([o, i, o], -1), np.stack([s, o, c], -1)], -2)


def earth_fixed_from_j2000(et: np.ndarray, t_unix: np.ndarray) -> np.ndarray:
    """Rotation matrices (n, 3, 3) from J2000 to an Earth-fixed frame: IAU 1976 precession to the mean equator and
    equinox of date, then Greenwich mean sidereal time (IAU 1982) with UT1 taken as UTC. Nutation (up to 0.005 deg) and
    polar motion are left out. pck00011's IAU_EARTH frame is not used: it turns with TDB rather than UT1 and puts the
    Moon about 0.07 deg off at the stations, against 0.003 deg for this rotation (checked against Astronomy Engine)."""
    T = np.asarray(et, dtype=np.float64) / 86400.0 / 36525.0
    zeta = (2306.2181 * T + 0.30188 * T ** 2 + 0.017998 * T ** 3) * _AS
    z = (2306.2181 * T + 1.09468 * T ** 2 + 0.018203 * T ** 3) * _AS
    th = (2004.3109 * T - 0.42665 * T ** 2 - 0.041833 * T ** 3) * _AS
    d = (np.asarray(t_unix, dtype=np.float64) - J2000_UNIX) / 86400.0
    tu = d / 36525.0
    gmst = np.radians((280.46061837 + 360.98564736629 * d + 0.000387933 * tu ** 2 - tu ** 3 / 38710000.0) % 360.0)
    return _rz(gmst) @ _rz(-z) @ _ry(th) @ _rz(-zeta)


def dsn_azel(t_unix) -> tuple[np.ndarray, np.ndarray]:
    """Azimuth and elevation (deg) of the Moon's centre at each DSN complex for many instants: arrays (3, n).
    Geometric (airless, no refraction), light time and stellar aberration corrected; azimuth from north through east.
    Stations on the pck00011 Earth ellipsoid (georec)."""
    import spiceypy as sp
    t = np.atleast_1d(np.asarray(t_unix, dtype=np.float64))
    with _lock:
        _load()
        et = unix_to_et(t)
        moon, _ = sp.spkpos("MOON", et, "J2000", "LT+S", "EARTH")
        _, radii = sp.bodvrd("EARTH", "RADII", 3)
    moon = np.einsum("nij,nj->ni", earth_fixed_from_j2000(et, t), np.asarray(moon, dtype=np.float64).reshape(-1, 3))
    re, rp = radii[0], radii[2]
    f = (re - rp) / re
    az = np.empty((len(DSN), len(t)))
    el = np.empty((len(DSN), len(t)))
    for k, (name, lat, lon, h) in enumerate(DSN):
        la, lo = np.radians(lat), np.radians(lon)
        stn = np.array(sp.georec(lo, la, h / 1000.0, re, f))
        up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
        east = np.array([-np.sin(lo), np.cos(lo), 0.0])
        north = np.cross(up, east)
        v = moon - stn
        d = np.linalg.norm(v, axis=1)
        el[k] = np.degrees(np.arcsin(np.clip(v @ up / d, -1, 1)))
        a = np.degrees(np.arctan2(v @ east, v @ north))
        az[k] = np.where(a < 0, a + 360, a)
    return az, el
