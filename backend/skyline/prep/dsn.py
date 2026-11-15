"""Moon azimuth and elevation at the three Deep Space Network complexes, hourly, one request per station per month.

JPL Horizons first (as for the Sun and Earth ephemeris): an OBSERVER table for the Moon (301) seen from the station's
geodetic coordinates on Earth (CENTER='coord@399'), quantity 4 (apparent azimuth and elevation, airless). That adds three
requests per month. If Horizons cannot be reached, the month comes from SPICE (spice.dsn_azel: spkpos of the Moon in
IAU_EARTH from pck00011, minus the station position from georec), marked so a later prefetch replaces it.

Station coordinates are main's (src/engine.js DSN list), altitude 900 m.
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import requests

from .. import config
from . import horizons, spice

STATIONS = [(name, lat, lon, h) for name, lat, lon, h in spice.DSN]
NAMES = [s[0] for s in STATIONS]


def request_params(station: str, month: str) -> dict:
    name, lat, lon, h = next(s for s in STATIONS if s[0] == station)
    t0, t1 = horizons.month_bounds(month)
    f = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")
    return {
        "format": "text", "COMMAND": "'301'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@399'", "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{lon:.4f},{lat:.4f},{h / 1000:.3f}'",
        "START_TIME": f"'{f(t0)}'", "STOP_TIME": f"'{f(t1 - 3600)}'", "STEP_SIZE": "'1 h'", "QUANTITIES": "'4'",
        "APPARENT": "'AIRLESS'", "CSV_FORMAT": "'YES'", "ANG_FORMAT": "'DEG'", "EXTRA_PREC": "'YES'",
    }


def fetch_month(station: str, month: str, timeout: float = config.HORIZONS_TIMEOUT_S, session=None):
    """Hourly (t_unix, az_deg, el_deg) for one station and calendar month from Horizons."""
    s = session or requests
    r = s.get(config.HORIZONS_URL, params=request_params(station, month), timeout=timeout, headers={"User-Agent": config.USER_AGENT})
    if r.status_code != 200:
        raise horizons.HorizonsError(f"HTTP {r.status_code}")
    t, az, el, _ = horizons.parse(r.text)
    t0, t1 = horizons.month_bounds(month)
    keep = (t >= t0) & (t < t1)
    t, az, el = t[keep], az[keep], el[keep]
    if len(t) != (t1 - t0) // 3600:
        raise horizons.HorizonsError(f"expected {(t1 - t0) // 3600} hourly rows for {station} {month}, got {len(t)}")
    return t, az, el


def spice_month(month: str):
    """Hourly (t_unix, az (3, n), el (3, n)) for all three stations from SPICE."""
    t0, t1 = horizons.month_bounds(month)
    t = np.arange(t0, t1, 3600, dtype=np.int64)
    az, el = spice.dsn_azel(t)
    return t, az, el
