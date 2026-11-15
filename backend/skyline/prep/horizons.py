"""JPL Horizons client: hourly Sun and Earth vectors in the Moon-fixed frame, one request per body per calendar month.

Method (DEVELOPMENT_PLAN.md section 5): an OBSERVER table from a reference point on the lunar equator at longitude 0
(CENTER='coord@301', SITE_COORD='0,0,0') with quantities 4 (apparent azimuth and elevation) and 20 (observer range).
At that point up = (1,0,0), north = (0,0,1), east = (0,1,0), so each row rebuilds the body vector exactly:
    v = 1737.4 * up + range_km * (cos(el) sin(az) east + cos(el) cos(az) north + sin(el) up)
engine.geometry.look() then gives the view from any other site.
"""
from __future__ import annotations

import re
from calendar import monthrange
from datetime import datetime, timezone

import numpy as np
import requests

from .. import config

SOURCE = "jpl-horizons"
BODY_CODE = {"sun": "10", "earth": "399"}
_MON = {m: i + 1 for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
_TIME = re.compile(r"^\s*(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?")


class HorizonsError(RuntimeError):
    pass


def month_bounds(month: str) -> tuple[int, int]:
    """Unix seconds of the first hour of the month and of the next month."""
    y, m = (int(v) for v in month.split("-"))
    t0 = int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp())
    t1 = t0 + monthrange(y, m)[1] * 86400
    return t0, t1


def request_params(body: str, month: str) -> dict:
    t0, t1 = month_bounds(month)
    f = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")
    return {
        "format": "text", "COMMAND": f"'{BODY_CODE[body]}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'", "SITE_COORD": "'0,0,0'",
        "START_TIME": f"'{f(t0)}'", "STOP_TIME": f"'{f(t1 - 3600)}'", "STEP_SIZE": "'1 h'",
        "QUANTITIES": "'4,20'", "CSV_FORMAT": "'YES'", "ANG_FORMAT": "'DEG'", "EXTRA_PREC": "'YES'",
    }


def parse(text: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Parse a CSV observer table: unix seconds, azimuth (deg), elevation (deg), range (AU)."""
    if "$$SOE" not in text:
        raise HorizonsError("Horizons returned no table: " + text[-400:].strip())
    head, rest = text.split("$$SOE", 1)
    body = rest.split("$$EOE", 1)[0]
    header = None
    for line in reversed(head.strip().splitlines()):
        if "Date" in line and "," in line:
            header = [c.strip() for c in line.split(",")]
            break
    if header is None:
        raise HorizonsError("Horizons table has no header line")
    ia = next(i for i, c in enumerate(header) if c.startswith("Azi"))
    ie = next(i for i, c in enumerate(header) if c.startswith("Elev"))
    ir = next(i for i, c in enumerate(header) if c == "delta")
    t, az, el, rg = [], [], [], []
    for row in body.strip().splitlines():
        f = [c.strip() for c in row.split(",")]
        m = _TIME.match(f[0])
        if not m:
            continue
        sec = float(m.group(6) or 0)
        dt = datetime(int(m.group(1)), _MON[m.group(2)], int(m.group(3)), int(m.group(4)), int(m.group(5)), tzinfo=timezone.utc)
        t.append(int(round(dt.timestamp() + sec)))
        az.append(float(f[ia]))
        el.append(float(f[ie]))
        rg.append(float(f[ir]))
    if not t:
        raise HorizonsError("Horizons table is empty")
    return np.array(t, dtype=np.int64), np.array(az), np.array(el), np.array(rg)


def reconstruct(az_deg: np.ndarray, el_deg: np.ndarray, range_au: np.ndarray) -> np.ndarray:
    """Moon-fixed body vectors (km) from apparent az/el and range seen at lat 0, lon 0, height 0."""
    a, e = np.radians(az_deg), np.radians(el_deg)
    ce = np.cos(e)
    d = np.stack([np.sin(e), ce * np.sin(a), ce * np.cos(a)], axis=-1)   # (up, east, north) = (x, y, z)
    p0 = np.array([config.RM, 0.0, 0.0])
    return p0 + (range_au * config.AU_KM)[:, None] * d


def fetch_month(body: str, month: str, timeout: float = config.HORIZONS_TIMEOUT_S, session=None) -> tuple[np.ndarray, np.ndarray, str]:
    """Hourly vectors for one body and calendar month. Returns (t_unix, xyz_km, raw_text)."""
    s = session or requests
    r = s.get(config.HORIZONS_URL, params=request_params(body, month), timeout=timeout, headers={"User-Agent": config.USER_AGENT})
    if r.status_code != 200:
        raise HorizonsError(f"HTTP {r.status_code}")
    t, az, el, rg = parse(r.text)
    t0, t1 = month_bounds(month)
    keep = (t >= t0) & (t < t1)
    t, az, el, rg = t[keep], az[keep], el[keep], rg[keep]
    want = (t1 - t0) // 3600
    if len(t) != want:
        raise HorizonsError(f"expected {want} hourly rows for {month}, got {len(t)}")
    return t, reconstruct(az, el, rg), r.text
