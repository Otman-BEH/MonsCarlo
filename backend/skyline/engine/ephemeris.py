"""Hourly Sun and Earth vectors from the SQLite cache, filled month by month from JPL Horizons (SPICE as fallback).

get_table(t0, n) returns an (n, 6) array [sx, sy, sz, ex, ey, ez] in km, Moon-fixed, exactly the shape of main's
Eng.makeTable. exact(t) interpolates between the hourly samples (cubic, 4-point Lagrange) for event refinement.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

from .. import config
from ..prep import horizons, spice
from ..prep.store import Store, default_store

HOUR = 3600
BODIES = ("sun", "earth")


class EphemerisError(RuntimeError):
    pass


def month_of(t_unix: int) -> str:
    d = datetime.fromtimestamp(int(t_unix), timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"


def months_between(t0: int, t1: int) -> list[str]:
    out, t = [], int(t0)
    while True:
        m = month_of(t)
        if not out or out[-1] != m:
            out.append(m)
        _, nxt = horizons.month_bounds(m)
        if nxt > t1:
            break
        t = nxt
    return out


def add_months(month: str, k: int) -> str:
    y, m = (int(v) for v in month.split("-"))
    i = y * 12 + (m - 1) + k
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


class Ephemeris:
    def __init__(self, store: Store | None = None, use_horizons: bool = True):
        self.store = store or default_store()
        self.use_horizons = use_horizons
        self._locks: dict = defaultdict(threading.Lock)
        self._glock = threading.Lock()
        self._mem: dict[str, tuple[np.ndarray, list[str]]] = {}   # month -> ((n,6) array, sources)

    def _lock_for(self, body: str, month: str) -> threading.Lock:
        with self._glock:
            return self._locks[(body, month)]

    def ensure_month(self, body: str, month: str, refresh_fallback: bool = False, log=None) -> str:
        """Make sure the month is cached. Returns its source. Horizons first, SPICE if Horizons fails."""
        with self._lock_for(body, month):
            info = self.store.month_info(body, month)
            if info and not (refresh_fallback and info["source"] != horizons.SOURCE):
                return info["source"]
            err = None
            if self.use_horizons:
                try:
                    t, xyz, _ = horizons.fetch_month(body, month)
                    self.store.put_month(body, month, t, xyz, horizons.SOURCE)
                    self._mem.pop(month, None)
                    return horizons.SOURCE
                except Exception as ex:   # network, HTTP, parse
                    err = ex
                    if log:
                        log(f"  Horizons failed for {body} {month}: {ex}; using SPICE")
            if info:          # keep the existing fallback rows
                return info["source"]
            if not spice.available():
                raise EphemerisError(f"no ephemeris for {body} {month}: Horizons unavailable ({err}) and SPICE kernels missing")
            t0, t1 = horizons.month_bounds(month)
            t = np.arange(t0, t1, HOUR, dtype=np.int64)
            s, e = spice.vectors(t)
            self.store.put_month(body, month, t, s if body == "sun" else e, spice.SOURCE)
            self._mem.pop(month, None)
            return spice.SOURCE

    def _month_array(self, month: str) -> tuple[np.ndarray, list[str]]:
        hit = self._mem.get(month)
        if hit is not None:
            return hit
        srcs = []
        cols = []
        t0, t1 = horizons.month_bounds(month)
        for b in BODIES:
            self.ensure_month(b, month)
            t, xyz, src = self.store.get_vectors(b, t0, t1 - HOUR)
            if len(t) != (t1 - t0) // HOUR:
                raise EphemerisError(f"cached month {b} {month} is incomplete ({len(t)} rows)")
            cols.append(xyz)
            srcs.append(src[0] if src else "?")
        a = np.hstack(cols)
        with self._glock:
            if len(self._mem) > 40:
                self._mem.clear()
            self._mem[month] = (a, srcs)
        return a, srcs

    def get_table(self, t0: int, n: int) -> tuple[np.ndarray, dict]:
        """Hourly table from t0 (aligned down to the hour), n rows. Returns (array (n,6), sources {month: {body: src}})."""
        t0 = int(t0) // HOUR * HOUR
        t_end = t0 + (n - 1) * HOUR
        out = np.empty((n, 6))
        sources = {}
        for m in months_between(t0, t_end):
            a, srcs = self._month_array(m)
            mt0, mt1 = horizons.month_bounds(m)
            lo, hi = max(t0, mt0), min(t_end, mt1 - HOUR)
            if hi < lo:
                continue
            out[(lo - t0) // HOUR:(hi - t0) // HOUR + 1] = a[(lo - mt0) // HOUR:(hi - mt0) // HOUR + 1]
            sources[m] = dict(zip(BODIES, srcs))
        return out, sources

    def exact(self, t: float) -> tuple[np.ndarray, np.ndarray]:
        """Sun and Earth vectors at any instant: 4-point Lagrange interpolation of the hourly samples."""
        tf = float(t)
        k = int(np.floor(tf / HOUR))
        a, _ = self.get_table((k - 1) * HOUR, 4)
        x = tf / HOUR - (k - 1)          # in [1, 2)
        nodes = np.arange(4.0)
        w = np.ones(4)
        for i in range(4):
            for j in range(4):
                if i != j:
                    w[i] *= (x - nodes[j]) / (nodes[i] - nodes[j])
        v = w @ a
        return v[:3], v[3:]

    def prefetch(self, months: int = config.PREFETCH_MONTHS, start: str | None = None, log=print) -> dict:
        start = start or month_of(int(time.time()))
        done = {}
        for k in range(months):
            m = add_months(start, k)
            for b in BODIES:
                had = self.store.month_info(b, m)
                src = self.ensure_month(b, m, refresh_fallback=True, log=log)
                done[f"{b} {m}"] = src
                if not had or had["source"] != src:
                    if log:
                        log(f"  ephemeris {b:5s} {m}: {src}")
                    if src == horizons.SOURCE:
                        time.sleep(config.HORIZONS_PAUSE_S)
        return done

    def coverage(self) -> dict:
        ms = self.store.months()
        full = sorted({r["month"] for r in ms if sum(1 for q in ms if q["month"] == r["month"]) == 2})
        return {"months_cached": len(full), "first": full[0] if full else None, "last": full[-1] if full else None,
                "sources": sorted({r["source"] for r in ms})}


_default: Ephemeris | None = None
_dlock = threading.Lock()


def default_ephemeris() -> Ephemeris:
    global _default
    with _dlock:
        if _default is None or _default.store is not default_store():
            _default = Ephemeris(default_store())
        return _default
