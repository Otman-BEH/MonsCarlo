"""Site catalogue, location resolution and horizons (precomputed for listed sites, cast on demand elsewhere)."""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from .. import config
from .terrain import HorizonMask, Terrain, default_terrain

SITES_PATH = Path(__file__).resolve().parent / "sites.json"


@lru_cache(maxsize=1)
def catalogue() -> list[dict]:
    return json.loads(SITES_PATH.read_text(encoding="utf-8"))["sites"]


def by_id(sid: str) -> dict | None:
    return next((s for s in catalogue() if s["id"] == sid), None)


class UnknownSite(KeyError):
    pass


class BadLocation(ValueError):
    pass


@dataclass
class Location:
    id: str | None
    name: str
    lat: float           # coordinates used (snapped for the listed polar sites, as main does)
    lon: float
    nominal_lat: float
    nominal_lon: float
    snapped: bool

    def as_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "lat": self.lat, "lon": self.lon,
                "nominal": {"lat": self.nominal_lat, "lon": self.nominal_lon}, "snapped": self.snapped}


def resolve(site: str | None = None, lat: float | None = None, lon: float | None = None) -> Location:
    if site:
        s = by_id(site)
        if s is None:
            raise UnknownSite(site)
        q = s.get("snapped")
        la, lo = (q["lat"], q["lon"]) if q else (s["lat"], s["lon"])
        return Location(s["id"], s["name"], la, lo, s["lat"], s["lon"], bool(q) and (abs(la - s["lat"]) > 1e-6 or abs(lo - s["lon"]) > 1e-6))
    if lat is None or lon is None:
        raise BadLocation("give site=<id> or both lat and lon")
    if not (-90 <= lat <= 90) or not (-360 <= lon <= 360):
        raise BadLocation("lat must be in [-90, 90] and lon in [-360, 360]")
    lo = ((lon + 180) % 360) - 180
    return Location(None, f"{abs(lat):.4f}°{'S' if lat < 0 else 'N'} {abs(lo):.4f}°{'W' if lo < 0 else 'E'}", float(lat), float(lo), float(lat), float(lo), False)


class HorizonMasks:
    """Loads precomputed site horizons from derived/horizon_masks; casts anything else with the terrain model."""

    def __init__(self, terrain: Terrain | None = None):
        self.terrain = terrain or default_terrain()
        self._idx = None
        self._mem: dict = {}
        self._lock = threading.Lock()

    def _index(self) -> dict:
        if self._idx is None:
            p = config.DERIVED_DIR / "horizon_masks" / "index.json"
            self._idx = json.loads(p.read_text()) if p.exists() else {"sites": {}}
        return self._idx

    def reload(self):
        with self._lock:
            self._idx = None
            self._mem.clear()

    def _precomputed(self, loc: Location, mode: str) -> HorizonMask | None:
        if not loc.id:
            return None
        rec = self._index()["sites"].get(loc.id, {}).get("modes", {}).get(mode)
        if rec is None:
            return None
        key = (loc.id, mode)
        with self._lock:
            hm = self._mem.get(key)
            if hm is None:
                m = np.load(config.DERIVED_DIR / "horizon_masks" / rec["file"]).astype(np.float64)
                idx = self._index()
                hm = HorizonMask(az_deg=np.arange(idx["naz"]) * 360.0 / idx["naz"], heights_m=[float(e) for e in idx["eyes_m"]],
                                 mask_deg=m, ground_m=rec["ground_m"], tiers=rec["tiers"], mode=mode, lat=loc.lat, lon=loc.lon)
                self._mem[key] = hm
            return hm

    def get(self, loc: Location, heights: list[float], mode: str = "best", naz: int = config.NAZ) -> tuple[HorizonMask, dict[float, np.ndarray]]:
        """Horizon and the mask at each requested height."""
        hm = self._precomputed(loc, mode) if naz == config.NAZ else None
        if hm is not None and max(heights) <= hm.heights_m[-1]:
            return hm, {h: hm.at_height(h) for h in heights}
        hm = self.terrain.horizon(loc.lat, loc.lon, sorted(set(float(h) for h in heights)), naz, mode)
        return hm, {h: hm.mask_deg[hm.heights_m.index(float(h))] for h in heights}


_default: HorizonMasks | None = None
_dlock = threading.Lock()


def default_horizon_masks() -> HorizonMasks:
    global _default
    with _dlock:
        if _default is None:
            _default = HorizonMasks()
        return _default


def reset_default():
    global _default
    with _dlock:
        _default = None
