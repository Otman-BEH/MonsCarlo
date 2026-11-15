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
from .sites import Location, HorizonMasks, default_horizon_masks
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
    def __init__(self, eph: Ephemeris | None = None, masks: HorizonMasks | None = None, store=None):
        self.eph = eph or default_ephemeris()
        self.sky = masks or default_horizon_masks()
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
            "horizon_deg": f(st[p + "Hz"]), "clearance_deg": f(st[p + "Clr"]), "visible_share": f(frac), "above_horizon": bool(st[p + "Clr"] > 0)}
        from .geometry import sub_point
        from ..prep import spice
        sp_lat, sp_lon = sub_point(s_vec)
        se_lat, se_lon = sub_point(e_vec)
        dsn = spice.dsn_view(t) if spice.available() else None
        return {
            "time": iso(t), "location": loc.as_dict(),
            "vectors_km": {"sun": [float(x) for x in s_vec], "earth": [float(x) for x in e_vec], "frame": "Moon-fixed (body-fixed), from the Moon's centre"},
            "subsolar": {"lat": float(sp_lat), "lon": float(sp_lon)}, "subearth": {"lat": float(se_lat), "lon": float(se_lon)},
            "dsn": dsn,
            "sun": {**body("sun", st["sunFrac"]), "irradiance_factor": f(st["irr"]), "share_not_eclipsed_by_earth": f(st["sunEcl"]),
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
                      "longest_radio_gap_h": st["maxOutD"] * 24, "longest_both_h": (st["maxBothD"] * 24),
                      "max_sun_elevation_deg": float(se["sunEl"].max()), "max_earth_elevation_deg": float(se["earthEl"].max())},
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
        if cfg["fault"]["kind"] != "none" or cfg["safe"]:
            clean = M.mission(se, i0, dict(cfg, fault={"kind": "none", "day": 0}), 0, False, shp)
            other = M.mission(se, i0, dict(cfg, safe=not cfg["safe"]), 0, False, shp)
            out["stress"] = {"without_fault": {"ok": clean["ok"], "fails": clean["fails"]},
                             "safe_mode_toggled": {"safe_mode": not cfg["safe"], "ok": other["ok"], "fails": other["fails"], "safe_mode_hours": other["safeH"]}}
        if trace:
            n = nom["n"]
            robk = M.mission(se, i0, cfg, cfg["margin"], True, shp)
            out["trace"] = {"time": [iso(t0 + (i0 + k) * HOUR) for k in range(n + 1)], "state_of_charge": np.round(nom["soc"], 5).tolist(),
                            "state_of_charge_with_margin": np.round(robk["soc"], 5).tolist(),
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

    # ---------------------------------------------------------------- data for the web page
    def series_window(self, loc: Location, start: float, hours: int, lander: dict, mode: str = "best", step_h: int = 1,
                      include_horizon: bool = True) -> dict:
        if hours < 1 or hours > 430 * 24:
            raise ValueError("hours must be between 1 and 10320 (430 days)")
        step_h = max(1, int(step_h))
        v, ter = self.view(loc, lander, mode)
        tab, t0, src = self.table(start, hours + 1)
        tab = tab[::step_h]
        se = V.series(v, tab)
        out = {"location": loc.as_dict(), "start": iso(t0), "start_unix": t0, "step_h": step_h, "n": se["n"],
               "series": {k: np.round(se[k], 4).tolist() for k in V.SERIES_KEYS},
               "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)}}
        if include_horizon:
            out["horizon"] = {"azimuth_step_deg": 360.0 / len(v.sun_mask), "sun": np.round(v.sun_mask, 4).tolist(),
                              "earth": np.round(v.earth_mask, 4).tolist(), "ground_m": v.ground_m, "tiers": ter["tiers"],
                              "lo_deg": float(min(v.sun_mask.min(), v.earth_mask.min())), "hi_deg": float(max(v.sun_mask.max(), v.earth_mask.max()))}
        return out

    def ephemeris_window(self, start: float, hours: int, step_h: int = 1) -> dict:
        if hours < 1 or hours > 430 * 24:
            raise ValueError("hours must be between 1 and 10320 (430 days)")
        tab, t0, src = self.table(start, hours + 1)
        tab = tab[:: max(1, int(step_h))]
        return {"start": iso(t0), "start_unix": t0, "step_h": max(1, int(step_h)), "n": len(tab),
                "sun_km": np.round(tab[:, :3], 1).tolist(), "earth_km": np.round(tab[:, 3:], 3).tolist(),
                "frame": "Moon-fixed (body-fixed), from the Moon's centre", "_meta": {"ephemeris": self._eph_sources(src)}}

    def design(self, loc: Location, landing: float, lander: dict, spec: M.MissionSpec, mode: str = "best",
               mass_of=(80.0, 160.0), atlas_start: float | None = None) -> dict:
        from . import design as D
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        a0 = landing if atlas_start is None else min(atlas_start, landing)
        first = int(math.floor(a0 / HOUR)) * HOUR
        span_h = max(int(math.ceil((landing - first) / HOUR)), 120 * 12) + days_h + 1
        tab, t0, src = self.table(first, span_h)
        v, ter = self.view(loc, lander, mode)
        se = V.series(v, tab)
        i0 = int(math.floor((landing - t0) / HOUR))
        out = D.lab(se, i0, cfg, mass_of, atlas_first=0)
        out["atlas_start"] = iso(t0)
        out["atlas_step_h"] = 12
        out["landing_time"] = iso(t0 + i0 * HOUR)
        out["_meta"] = {"terrain": ter, "ephemeris": self._eph_sources(src)}
        return out

    def calendar(self, locs: list[Location], start: float, lander: dict, spec: M.MissionSpec, mode: str = "best", days: int = 366) -> dict:
        from . import planning as P
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        t0 = int(math.floor(start / 86400)) * 86400
        tab, t0, src = self.table(t0, days * 24 + days_h + 1)
        out = {"start": iso(t0), "days": days, "sites": []}
        tiers = set()
        for loc in locs:
            v, ter = self.view(loc, lander, mode)
            tiers.update(ter["tiers"])
            out["sites"].append({"location": loc.as_dict(), **P.calendar(V.series(v, tab), cfg, days)})
        out["_meta"] = {"terrain": {"dem": mode, "tiers": sorted(tiers)}, "ephemeris": self._eph_sources(src)}
        return out

    def rescue(self, plan: Location, plan_time: float, locs: list[Location], lander: dict, spec: M.MissionSpec,
               slip_days: int, flex_days: int, mode: str = "best") -> dict:
        from . import planning as P
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        tP = int(math.floor(plan_time / HOUR)) * HOUR
        n = (slip_days + flex_days) * 24 + days_h + 1
        tab, t0, src = self.table(tP, n)
        iS = slip_days * 24
        pv, _ = self.view(plan, lander, mode)
        pse = V.series(pv, tab)
        base = M.verdict(pse, 0, cfg)
        slipped = M.verdict(pse, iS, cfg)
        if not any(l.id == plan.id and l.lat == plan.lat and l.lon == plan.lon for l in locs):
            locs = [plan] + list(locs)
        alts = []
        for loc in locs:
            v, ter = self.view(loc, lander, mode)
            r = P.rescue_site(pse if loc is plan else V.series(v, tab), iS, flex_days, cfg)
            alts.append((loc, r, ter))
        alts.sort(key=lambda a: (-a[1]["state"], (a[1]["i"] if a[1]["state"] else 0), -a[1]["verdict"]["nom"]["minSoc"]))

        def vd(v):
            st = v["state"]
            return {"verdict": M.VERDICTS[st], "state": st, "nominal": M.summary_of(v["nom"], cfg["capWh"]),
                    "with_terrain_margin": M.summary_of(v["rob"], cfg["capWh"]) if v["rob"] else None,
                    "reasons": v["nom"]["fails"] if st == 0 else (v["rob"]["fails"] if st == 1 else [])}
        return {"plan": {"location": plan.as_dict(), "landing_time": iso(tP), **vd(base)},
                "after_slip": {"landing_time": iso(tP + iS * HOUR), **vd(slipped)}, "slip_days": slip_days, "flex_days": flex_days,
                "alternatives": [{"location": loc.as_dict(), "landing_time": iso(tP + r["i"] * HOUR) if r["state"] else None,
                                  "extra_wait_days": (r["i"] - iS) / 24 if r["state"] else None, "good_landing_days": r["good_days"],
                                  "terrain": ter["tiers"][0] if ter["tiers"] else None, **vd(r["verdict"])} for loc, r, ter in alts],
                "_meta": {"terrain": {"dem": mode}, "ephemeris": self._eph_sources(src)}}
