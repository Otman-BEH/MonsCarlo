"""NASA Deep Space Network: the three complexes, their antennas, and when each one can see the Moon.

A lander can talk to Earth only when two things are true at once:
  1. Earth is above the lander's terrain horizon (engine.visibility, earthClr > 0), and
  2. at least one DSN complex has the Moon above its elevation limit.

Moon elevation at each complex comes from SPICE (IAU_EARTH frame, light time and stellar aberration corrected).
The complexes are roughly 120 degrees apart in longitude, so the Moon is usually up at one of them, but when its
declination is far south or north there are short gaps. Antennas inside one complex are within a few hundred metres
of each other, so one elevation per complex is enough.

Not modelled: antenna scheduling (other missions share the dishes), link budget, weather, and keyhole limits.
"""
from __future__ import annotations

import threading
from collections import OrderedDict

import numpy as np

from ..prep import spice

ELEVATION_LIMIT_DEG = 10.0     # usual planning limit; some 34 m dishes track down to about 6 degrees

# Antenna roster as of late 2026 (DSS-23 entered service in August 2026). DSS-13 (R&D) and DSS-16 (26 m, in extended
# downtime) at Goldstone are left out.
COMPLEXES = [
    {"id": "gdscc", "name": "Goldstone", "where": "California, USA", "lat": 35.4267, "lon": -116.8900, "alt_m": 1000.0,
     "antennas": [{"id": "DSS-14", "diameter_m": 70, "type": "70 m"},
                  {"id": "DSS-23", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-24", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-25", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-26", "diameter_m": 34, "type": "34 m beam waveguide"}]},
    {"id": "mdscc", "name": "Madrid", "where": "Robledo de Chavela, Spain", "lat": 40.4314, "lon": -4.2481, "alt_m": 865.0,
     "antennas": [{"id": "DSS-63", "diameter_m": 70, "type": "70 m"},
                  {"id": "DSS-65", "diameter_m": 34, "type": "34 m high efficiency"},
                  {"id": "DSS-53", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-54", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-55", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-56", "diameter_m": 34, "type": "34 m beam waveguide"}]},
    {"id": "cdscc", "name": "Canberra", "where": "Tidbinbilla, Australia", "lat": -35.4014, "lon": 148.9817, "alt_m": 690.0,
     "antennas": [{"id": "DSS-43", "diameter_m": 70, "type": "70 m"},
                  {"id": "DSS-34", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-35", "diameter_m": 34, "type": "34 m beam waveguide"},
                  {"id": "DSS-36", "diameter_m": 34, "type": "34 m beam waveguide"}]},
]

_cache: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_clock = threading.Lock()


def available() -> bool:
    return spice.available()


def _elevations(t_unix: np.ndarray) -> np.ndarray:
    """Moon-centre elevation (deg) at each complex, shape (3, n). Geometric, no refraction."""
    import spiceypy as sp
    t = np.atleast_1d(np.asarray(t_unix, dtype=np.float64))
    with spice._lock:
        spice._load()
        et = spice.unix_to_et(t)
        moon, _ = sp.spkpos("MOON", et, "IAU_EARTH", "LT+S", "EARTH")
        _, radii = sp.bodvrd("EARTH", "RADII", 3)
        re, rp = radii[0], radii[2]
        f = (re - rp) / re
        stations = [np.array(sp.georec(np.radians(c["lon"]), np.radians(c["lat"]), c["alt_m"] / 1000.0, re, f)) for c in COMPLEXES]
    moon = np.asarray(moon, dtype=np.float64).reshape(-1, 3)
    out = np.empty((len(COMPLEXES), len(t)))
    for k, (c, stn) in enumerate(zip(COMPLEXES, stations)):
        la, lo = np.radians(c["lat"]), np.radians(c["lon"])
        up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
        v = moon - stn
        out[k] = np.degrees(np.arcsin((v @ up) / np.linalg.norm(v, axis=1)))
    return out


def hourly(t0: int, n: int) -> np.ndarray | None:
    """Elevations (3, n) for the hours t0, t0 + 3600, ... Cached; None when the SPICE kernels are missing."""
    if not available():
        return None
    key = (int(t0), int(n))
    with _clock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    el = _elevations(t0 + 3600.0 * np.arange(n))
    with _clock:
        _cache[key] = el
        while len(_cache) > 64:
            _cache.popitem(last=False)
    return el


def contact_mask(el: np.ndarray, limit: float = ELEVATION_LIMIT_DEG) -> np.ndarray:
    """True for each sample where at least one complex has the Moon above the limit."""
    return (el > limit).any(axis=0)


def best(el: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Highest Moon elevation over the complexes and which complex it is (index into COMPLEXES)."""
    return el.max(axis=0), el.argmax(axis=0)


def apply(se: dict, ok: np.ndarray | None) -> dict:
    """Series where Earth counts as out of reach whenever no complex can see the Moon. Every link check downstream
    (mission, design, calendar, rescue, Monte Carlo) then includes the ground stations without further changes."""
    if ok is None:
        return se
    out = dict(se)
    n = se["n"]
    out["earthClr"] = np.where(ok[:n], se["earthClr"], np.minimum(se["earthClr"], -90.0))
    return out


def view(t_unix: float) -> list[dict]:
    """Each complex at one instant: Moon elevation, whether it is above the limit, and its antennas."""
    el = _elevations(np.array([float(t_unix)]))[:, 0]
    return [{"id": c["id"], "name": c["name"], "where": c["where"], "elevation_deg": float(e),
             "in_view": bool(e > ELEVATION_LIMIT_DEG), "antennas": c["antennas"]} for c, e in zip(COMPLEXES, el)]


def catalogue() -> dict:
    return {"elevation_limit_deg": ELEVATION_LIMIT_DEG,
            "complexes": [{k: c[k] for k in ("id", "name", "where", "lat", "lon", "alt_m", "antennas")} for c in COMPLEXES]}
