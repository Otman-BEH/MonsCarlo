"""Deep Space Network view: hourly Moon azimuth and elevation at Goldstone, Madrid and Canberra from the SQLite cache,
filled month by month from JPL Horizons with SPICE as the fallback (prep/dsn.py), like the Sun and Earth ephemeris.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict

import numpy as np

from .. import config
from ..prep import dsn as PD
from ..prep import horizons, spice
from ..prep.store import Store, default_store
from .ephemeris import EphemerisError, add_months, month_of, months_between

HOUR = 3600
MIN_EL_DEG = 10.0      # main treats 10 deg as the lowest usable elevation


class DsnView:
    def __init__(self, store: Store | None = None, use_horizons: bool = True):
        self.store = store or default_store()
        self.use_horizons = use_horizons
        self._locks: dict = defaultdict(threading.Lock)
        self._glock = threading.Lock()
        self._mem: dict = {}

    def _lock_for(self, month: str) -> threading.Lock:
        with self._glock:
            return self._locks[month]

    def ensure_month(self, month: str, refresh_fallback: bool = False, log=None) -> dict:
        """Make sure every station's month is cached. Returns {station: source}."""
        with self._lock_for(month):
            out, need = {}, []
            for st in PD.NAMES:
                info = self.store.dsn_month_info(st, month)
                if info and not (refresh_fallback and info["source"] != horizons.SOURCE):
                    out[st] = info["source"]
                else:
                    need.append((st, info))
            if not need:
                return out
            spice_rows = None
            for st, info in need:
                if self.use_horizons:
                    try:
                        t, az, el = PD.fetch_month(st, month)
                        self.store.put_dsn_month(st, month, t, az, el, horizons.SOURCE)
                        out[st] = horizons.SOURCE
                        self._mem.pop(month, None)
                        time.sleep(config.HORIZONS_PAUSE_S if refresh_fallback else 0)
                        continue
                    except Exception as ex:   # network, HTTP, parse
                        if log:
                            log(f"  Horizons failed for DSN {st} {month}: {ex}; using SPICE")
                if info:
                    out[st] = info["source"]
                    continue
                if not spice.available():
                    raise EphemerisError(f"no DSN data for {st} {month}: Horizons unavailable and SPICE kernels missing")
                if spice_rows is None:
                    spice_rows = PD.spice_month(month)
                t, az, el = spice_rows
                k = PD.NAMES.index(st)
                self.store.put_dsn_month(st, month, t, az[k], el[k], spice.SOURCE)
                out[st] = spice.SOURCE
                self._mem.pop(month, None)
            return out

    def _month(self, month: str):
        hit = self._mem.get(month)
        if hit is not None:
            return hit
        srcs = self.ensure_month(month)
        t0, t1 = horizons.month_bounds(month)
        az, el = [], []
        for st in PD.NAMES:
            t, a, e, _ = self.store.get_dsn(st, t0, t1 - HOUR)
            if len(t) != (t1 - t0) // HOUR:
                raise EphemerisError(f"cached DSN month {st} {month} is incomplete ({len(t)} rows)")
            az.append(a)
            el.append(e)
        hit = (np.array(az), np.array(el), srcs)
        with self._glock:
            if len(self._mem) > 30:
                self._mem.clear()
            self._mem[month] = hit
        return hit

    def series(self, t0: int, n: int) -> tuple[np.ndarray, np.ndarray, dict]:
        """Hourly azimuth and elevation, arrays (3, n), from t0 aligned down to the hour, and sources per month."""
        t0 = int(t0) // HOUR * HOUR
        t_end = t0 + (n - 1) * HOUR
        az = np.empty((3, n))
        el = np.empty((3, n))
        src = {}
        for m in months_between(t0, t_end):
            a, e, s = self._month(m)
            mt0, mt1 = horizons.month_bounds(m)
            lo, hi = max(t0, mt0), min(t_end, mt1 - HOUR)
            if hi < lo:
                continue
            az[:, (lo - t0) // HOUR:(hi - t0) // HOUR + 1] = a[:, (lo - mt0) // HOUR:(hi - mt0) // HOUR + 1]
            el[:, (lo - t0) // HOUR:(hi - t0) // HOUR + 1] = e[:, (lo - mt0) // HOUR:(hi - mt0) // HOUR + 1]
            src[m] = s
        return az, el, src

    def at(self, t: float) -> tuple[np.ndarray, np.ndarray, dict]:
        """Azimuth and elevation (3,) at any instant: 4-point Lagrange interpolation of the hourly values."""
        k = int(np.floor(float(t) / HOUR))
        az, el, src = self.series((k - 1) * HOUR, 4)
        x = float(t) / HOUR - (k - 1)
        w = np.ones(4)
        for i in range(4):
            for j in range(4):
                if i != j:
                    w[i] *= (x - j) / (i - j)
        azu = np.unwrap(np.radians(az), axis=1)
        return np.degrees(azu @ w) % 360, el @ w, src

    def prefetch(self, months: int = config.PREFETCH_MONTHS, start: str | None = None, log=print) -> dict:
        start = start or month_of(int(time.time()))
        done = {}
        for k in range(months):
            m = add_months(start, k)
            had = {st: self.store.dsn_month_info(st, m) for st in PD.NAMES}
            src = self.ensure_month(m, refresh_fallback=True, log=log)
            done[m] = src
            if log and any(not had[st] or had[st]["source"] != src[st] for st in PD.NAMES):
                log(f"  DSN {m}: " + ", ".join(f"{st} {src[st]}" for st in PD.NAMES))
        return done

    def coverage(self) -> dict:
        ms = self.store.dsn_months()
        full = sorted({r["month"] for r in ms if sum(1 for q in ms if q["month"] == r["month"]) == len(PD.NAMES)})
        return {"months_cached": len(full), "first": full[0] if full else None, "last": full[-1] if full else None,
                "sources": sorted({r["source"] for r in ms})}


def visible_any(el: np.ndarray, min_el: float = MIN_EL_DEG) -> np.ndarray:
    return (np.asarray(el) >= min_el).any(axis=0)


_default: DsnView | None = None
_dlock = threading.Lock()


def default_dsn() -> DsnView:
    global _default
    with _dlock:
        if _default is None or _default.store is not default_store():
            _default = DsnView(default_store())
        return _default
