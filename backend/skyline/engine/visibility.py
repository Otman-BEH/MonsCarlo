"""Hourly visibility series, crossings, window statistics. Port of main's src/analysis.js (stateWith, seriesAt, nextCross,
stats) and src/app.js (nextEvent), vectorised over hours.

Two skylines per site: the Sun is judged against the skyline at the solar array height, Earth against the skyline at the
antenna height. Each uses its own site basis (ground + that height).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import REARTH, RSUN
from .geometry import disc_frac, irradiance, look, site_basis
from .terrain import mask_at

F32 = np.float32


@dataclass
class View:
    """Everything needed to evaluate a site: position, ground height and the two skylines."""
    lat: float
    lon: float
    ground_m: float
    sun_mask: np.ndarray       # skyline at the array height, (naz,)
    earth_mask: np.ndarray     # skyline at the antenna height, (naz,)
    array_h: float
    antenna_h: float


def _lat(lat: float) -> float:
    return max(-89.999, min(89.999, lat))


def state_at(v: View, sun: np.ndarray, earth: np.ndarray) -> dict:
    """Sun and Earth state at one or more instants (vectors (..., 3) in km). Float64 throughout."""
    bs = site_basis(_lat(v.lat), v.lon, (v.ground_m + v.array_h) / 1000.0)
    be = site_basis(_lat(v.lat), v.lon, (v.ground_m + v.antenna_h) / 1000.0)
    s = look(bs, sun, RSUN)
    e = look(be, earth, REARTH)
    hs = mask_at(v.sun_mask, s["az"])
    he = mask_at(v.earth_mask, e["az"])
    return {"sunEl": s["el"], "sunAz": s["az"], "sunRad": s["rad"], "sunHz": hs, "sunClr": s["el"] - hs,
            "sunFrac": disc_frac(s["el"], s["rad"], hs), "sunDist": s["dist"],
            "earthEl": e["el"], "earthAz": e["az"], "earthRad": e["rad"], "earthHz": he, "earthClr": e["el"] - he,
            "earthFrac": disc_frac(e["el"], e["rad"], he), "irr": irradiance(s["dist"])}


SERIES_KEYS = ("sunEl", "sunAz", "sunClr", "sunFrac", "earthEl", "earthAz", "earthClr", "irr", "sunRad")


def series(v: View, table: np.ndarray) -> dict[str, np.ndarray]:
    """Hourly series over a (n, 6) table. Values are rounded to float32 like main's Float32Array storage."""
    st = state_at(v, table[:, :3], table[:, 3:])
    out = {k: st[k].astype(F32).astype(np.float64) for k in SERIES_KEYS}
    out["n"] = table.shape[0]
    return out


def next_cross(arr: np.ndarray, x: float, n: int):
    """Next zero crossing of arr after fractional index x: (idx, rising) or None. Port of Ana.nextCross."""
    i = max(0, int(np.floor(x)))
    f = x - i
    prev = arr[i] * (1 - f) + arr[i + 1] * f if i + 1 < n else arr[min(i, n - 1)]
    px = x
    if i + 1 >= n:
        return None
    seg = np.asarray(arr[i + 1:n])
    pos = seg > 0
    flips = np.nonzero(pos != np.concatenate([[prev > 0], pos[:-1]]))[0]
    if len(flips) == 0:
        return None
    j = int(flips[0]) + i + 1
    if j > i + 1:
        prev = arr[j - 1]
        px = j - 1
    v = arr[j]
    return px + (j - px) * (prev / (prev - v)), bool(v > 0)


def _runs(b: np.ndarray) -> list[tuple[int, int]]:
    """Index intervals [start, end) where b is true."""
    if len(b) == 0:
        return []
    d = np.diff(np.concatenate([[0], b.astype(np.int8), [0]]))
    return list(zip(np.nonzero(d == 1)[0].tolist(), np.nonzero(d == -1)[0].tolist()))


def _max_run(b: np.ndarray) -> int:
    r = _runs(b)
    return max((e - s for s, e in r), default=0)


def stats(se: dict, i0: int, i1: int, step_h: float = 1.0, need_earth: bool = True) -> dict:
    """Port of Ana.stats over samples [i0, i1)."""
    L = se["sunClr"][i0:i1] > 0
    K = se["earthClr"][i0:i1] > 0
    B = L & (K | (not need_earth))
    n = i1 - i0
    d = step_h / 24.0
    sf = se["sunFrac"][i0:i1]
    return {"litPct": 100 * L.sum() / n, "linkPct": 100 * K.sum() / n, "bothPct": 100 * B.sum() / n,
            "pTrack": 100 * sf.sum() / n, "pFlat": 100 * (sf * np.maximum(0, np.sin(np.radians(se["sunEl"][i0:i1])))).sum() / n,
            "maxLitD": _max_run(L) * d, "maxDarkD": _max_run(~L) * d, "maxOutD": _max_run(~K) * d, "maxBothD": _max_run(B) * d}


def intervals(b: np.ndarray, t0: int, step_s: int) -> list[dict]:
    return [{"start": t0 + s * step_s, "end": t0 + e * step_s, "hours": (e - s) * step_s / 3600} for s, e in _runs(b)]


def next_event(v: View, eph, se: dict, t0_table: int, t_now: float, key: str, iters: int = 11):
    """Next time the clearance `key` ('sunClr' or 'earthClr') changes sign after t_now, refined by bisection on the exact
    ephemeris (main's nextEvent). Returns (t_unix, rising) or None."""
    n = se["n"]
    x = (t_now - t0_table) / 3600.0
    if x < 0 or x > n - 1:
        return None
    c = next_cross(se[key], x, n)
    if c is None:
        return None
    idx, rising = c

    def f(t):
        s, e = eph.exact(t)
        return float(state_at(v, s, e)[key])
    a = max(t_now, t0_table + np.floor(idx) * 3600.0)
    b = t0_table + np.ceil(idx + 1e-9) * 3600.0
    fa = f(a)
    if (fa > 0) == (f(b) > 0):
        return t0_table + idx * 3600.0, rising
    for _ in range(iters):
        m = (a + b) / 2
        fm = f(m)
        if (fa > 0) == (fm > 0):
            a, fa = m, fm
        else:
            b = m
    return (a + b) / 2, rising
