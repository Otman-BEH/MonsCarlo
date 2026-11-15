"""The questions the API answers, as plain functions over the engine. Used by the HTTP routes and the CLI."""
from __future__ import annotations

import math
import time
from datetime import datetime, timezone

import numpy as np

from .. import config
from . import landers as LD
from . import mission as M
from . import montecarlo as MC
from . import visibility as V
from .ephemeris import Ephemeris, EphemerisError, default_ephemeris
from .geometry import disc_frac
from .sites import Location, Skylines, default_skylines
from .terrain import mask_at

HOUR = 3600
EVENT_DAYS = 90               # how far ahead /sky looks for the next sunset, sunrise, Earthset, Earthrise
T_MIN = datetime(1900, 1, 1, tzinfo=timezone.utc).timestamp()
T_MAX = datetime(2100, 1, 1, tzinfo=timezone.utc).timestamp()


class OutOfCoverage(ValueError):
    pass


def iso(t: float | None) -> str | None:
    if t is None:
        return None
    return datetime.fromtimestamp(float(t), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(s: str | None, default: float | None = None) -> float:
    if s is None or s == "" or s == "now":
        return float(default if default is not None else time.time())
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        raise ValueError(f"time {s!r} is not ISO 8601 (for example 2026-12-01T06:00:00Z)")
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    t = d.timestamp()
    if not (T_MIN <= t <= T_MAX):
        raise OutOfCoverage("times must be between 1900 and 2100")
    return t


def fmt_dur(hours: float) -> str:
    if hours < 1:
        return f"{max(1, round(hours * 60))} min"
    if hours < 48:
        h = int(hours)
        return f"{h} h {round((hours - h) * 60) % 60:02d} min"
    d = int(hours // 24)
    return f"{d} d {round(hours - d * 24)} h"


class Engine:
    def __init__(self, eph: Ephemeris | None = None, skylines: Skylines | None = None, store=None):
        self.eph = eph or default_ephemeris()
        self.sky = skylines or default_skylines()
        self.store = store or self.eph.store

    # ---------------------------------------------------------------- building blocks
    def view(self, loc: Location, lander: dict, mode: str, naz: int = config.NAZ) -> tuple[V.View, dict]:
        ah = float(lander["power"]["array"]["height_m"])
        eh = float(lander["comms"]["antenna_height_m"])
        hm, masks = self.sky.get(loc, [ah, eh], mode, naz)
        v = V.View(lat=loc.lat, lon=loc.lon, ground_m=hm.ground_m, sun_mask=masks[ah], earth_mask=masks[eh], array_h=ah, antenna_h=eh)
        return v, {"dem": mode, "tiers": hm.tiers, "ground_m": hm.ground_m}

    def table(self, t0: float, n: int) -> tuple[np.ndarray, int, dict]:
        t0h = int(math.floor(t0 / HOUR)) * HOUR
        tab, src = self.eph.get_table(t0h, n)       # EphemerisError -> 503 in the API
        return tab, t0h, src

    @staticmethod
    def _eph_sources(src: dict) -> dict:
        return {m: s for m, s in sorted(src.items())}

    # ---------------------------------------------------------------- /sky
    def sky_now(self, loc: Location, t: float, lander: dict, mode: str = "best") -> dict:
        v, ter = self.view(loc, lander, mode)
        s_vec, e_vec = self.eph.exact(t)
        st = V.state_at(v, s_vec, e_vec)
        tab, t0, src = self.table(t - HOUR, EVENT_DAYS * 24 + 2)
        se = V.series(v, tab)
        events = {}
        for key, rise_name, set_name in (("sunClr", "sunrise", "sunset"), ("earthClr", "earthrise", "earthset")):
            x = t
            found = {}
            for _ in range(2):
                ev = V.next_event(v, self.eph, se, t0, x, key)
                if ev is None:
                    break
                tt, rising = ev
                name = rise_name if rising else set_name
                found.setdefault(name, tt)
                x = tt + 60
            for name in (rise_name, set_name):
                tt = found.get(name)
                events[name] = {"time": iso(tt), "in_hours": (tt - t) / 3600 if tt is not None else None,
                                "in_text": fmt_dur((tt - t) / 3600) if tt is not None else f"not within {EVENT_DAYS} days"}
        f = float
        body = lambda p, frac: {
            "azimuth_deg": f(st[p + "Az"]), "elevation_deg": f(st[p + "El"]), "angular_radius_deg": f(st[p + "Rad"]),
            "skyline_deg": f(st[p + "Hz"]), "clearance_deg": f(st[p + "Clr"]), "visible_share": f(frac), "above_skyline": bool(st[p + "Clr"] > 0)}
        return {
            "time": iso(t), "location": loc.as_dict(),
            "sun": {**body("sun", st["sunFrac"]), "irradiance_factor": f(st["irr"]),
                    "next_sunset": events["sunset"], "next_sunrise": events["sunrise"]},
            "earth": {**body("earth", st["earthFrac"]), "next_earthset": events["earthset"], "next_earthrise": events["earthrise"]},
            "heights": {"array_m": v.array_h, "antenna_m": v.antenna_h, "ground_m": v.ground_m},
            "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)},
        }

    # ---------------------------------------------------------------- /windows
    def windows(self, loc: Location, start: float, end: float, lander: dict, mode: str = "best", step_h: int = 1,
                need_earth: bool = True, series: bool = False) -> dict:
        if end <= start:
            raise ValueError("end must be after start")
        if (end - start) > 400 * 86400:
            raise ValueError("the window is limited to 400 days")
        step_h = max(1, int(step_h))
        n_h = int(math.ceil((end - start) / HOUR)) + 1
        v, ter = self.view(loc, lander, mode)
        tab, t0, src = self.table(start, n_h)
        tab = tab[::step_h]
        se = V.series(v, tab)
        n = se["n"]
        st = V.stats(se, 0, n, step_h, need_earth)
        L = se["sunClr"] > 0
        K = se["earthClr"] > 0
        B = L & K
        out = {
            "start": iso(t0), "end": iso(t0 + (n - 1) * step_h * HOUR), "step_h": step_h, "samples": n, "location": loc.as_dict(),
            "stats": {"sunlit_pct": st["litPct"], "earth_in_view_pct": st["linkPct"], "both_pct": 100 * B.sum() / n,
                      "power_share_tracking_pct": st["pTrack"], "power_share_horizontal_pct": st["pFlat"],
                      "longest_sunlit_h": st["maxLitD"] * 24, "longest_dark_h": st["maxDarkD"] * 24,
                      "longest_radio_gap_h": st["maxOutD"] * 24, "longest_both_h": (st["maxBothD"] * 24)},
            "intervals": {"sunlit": V.intervals(L, t0, step_h * HOUR), "earth_in_view": V.intervals(K, t0, step_h * HOUR),
                          "both": V.intervals(B, t0, step_h * HOUR)},
            "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)},
        }
        for k in out["intervals"].values():
            for iv in k:
                iv["start"], iv["end"] = iso(iv["start"]), iso(iv["end"])
        if series:
            out["series"] = {"time": [iso(t0 + i * step_h * HOUR) for i in range(n)],
                             **{k: np.round(se[k], 5).tolist() for k in V.SERIES_KEYS}}
        return out

    # ---------------------------------------------------------------- /mission
    def mission(self, loc: Location, landing: float, lander: dict, spec: M.MissionSpec, mode: str = "best",
                risk: bool = False, unc: MC.Uncertainty | None = None, trace: bool = False) -> dict:
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        unc = unc or MC.Uncertainty()
        J, after = MC.window_hours(unc, spec.duration_days) if risk else (0, days_h + 1)
        tab, t0, src = self.table(landing - J * HOUR, J + after)
        i0 = int(math.floor((landing - t0) / HOUR))
        v, ter = self.view(loc, lander, mode)
        se = V.series(v, tab)
        shp = M.power_shape(se, cfg)
        vd = M.verdict(se, i0, cfg, shp)
        nom = M.mission(se, i0, cfg, 0, True, shp)
        rob = M.mission(se, i0, cfg, cfg["margin"], False, shp)
        state = vd["state"]
        reasons = nom["fails"] if state == 0 else (rob["fails"] if state == 1 else [])
        out = {
            "location": loc.as_dict(), "landing_time": iso(t0 + i0 * HOUR), "duration_days": spec.duration_days,
            "verdict": M.VERDICTS[state], "verdict_text": M.VERDICT_TEXT[state], "reasons": reasons,
            "nominal": M.summary_of(nom, cfg["capWh"]), "with_terrain_margin": M.summary_of(rob, cfg["capWh"]),
            "terrain_margin_deg": cfg["margin"], "mission": spec.model_dump(),
            "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)},
        }
        if trace:
            n = nom["n"]
            out["trace"] = {"time": [iso(t0 + (i0 + k) * HOUR) for k in range(n + 1)], "state_of_charge": np.round(nom["soc"], 5).tolist(),
                            "sun_share": np.round(nom["sun"], 4).tolist(), "earth_link": nom["link"].astype(int).tolist(),
                            "safe_mode": nom["safeArr"].astype(int).tolist()}
        if risk:
            if loc.lat > -80.0:
                out["risk"] = {"available": False, "reason": "the landing-risk analysis needs the polar elevation models (80S to the pole)"}
            else:
                t_r = time.time()
                r = MC.run_risk(self.sky.terrain, tab, i0, loc.lat, loc.lon, lander, cfg, unc, mode)
                r["available"] = True
                r["seconds"] = round(time.time() - t_r, 2)
                out["risk"] = r
        return out

    # ---------------------------------------------------------------- /horizon
    def horizon(self, loc: Location, heights: list[float], mode: str = "best") -> dict:
        hm, masks = self.sky.get(loc, heights, mode)
        return {"location": loc.as_dict(), "dem": mode, "ground_m": hm.ground_m, "tiers": hm.tiers,
                "azimuth_deg": hm.az_deg.tolist(),
                "horizon_deg": {f"{h:g}": np.round(masks[h], 4).tolist() for h in heights}}
