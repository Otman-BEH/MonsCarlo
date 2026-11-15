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
    """Elevation of the Moon's centre above the horizon at each DSN complex (IAU_EARTH from pck00011, light time and
    stellar aberration corrected): geometric elevation, no atmospheric refraction. Above 15 deg it agrees with main's
    Astronomy Engine values to 0.06 deg; near and below the horizon main's figures are lifted by its 'normal' refraction
    (up to about 0.7 deg), which does not matter for the 10 deg visibility check."""
    import spiceypy as sp
    with _lock:
        _load()
        et = float(unix_to_et(np.array([t_unix]))[0])
        moon, _ = sp.spkpos("MOON", et, "IAU_EARTH", "LT+S", "EARTH")
        _, radii = sp.bodvrd("EARTH", "RADII", 3)
    re, rp = radii[0], radii[2]
    f = (re - rp) / re
    out = []
    for name, lat, lon, h in DSN:
        la, lo = np.radians(lat), np.radians(lon)
        stn = np.array(sp.georec(lo, la, h / 1000.0, re, f))
        up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
        v = np.asarray(moon) - stn
        out.append({"name": name, "elevation_deg": float(np.degrees(np.arcsin(v @ up / np.linalg.norm(v))))})
    return out
