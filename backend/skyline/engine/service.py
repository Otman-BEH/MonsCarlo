"""The questions the API answers, as plain functions over the engine. Used by the HTTP routes and the CLI."""
from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict
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


def loc_key(loc: Location) -> str:
    return loc.id or f"{loc.lat:.6f},{loc.lon:.6f}"


class Engine:
    SERIES_CACHE = 96          # multi-site series kept in memory (each is a few arrays of n float64)

    def __init__(self, eph: Ephemeris | None = None, skylines: Skylines | None = None, store=None):
        self.eph = eph or default_ephemeris()
        self.sky = skylines or default_skylines()
        self.store = store or self.eph.store
        self._series: "OrderedDict[tuple, tuple[dict, dict]]" = OrderedDict()
        self._slock = threading.Lock()

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

    def series_many(self, locations: list[Location], t0: float, n: int, lander: dict, mode: str = "best"):
        """Hourly series for several sites over the same hours. The ephemeris table does not depend on the site, so it
        is read once; each site's series is cached in memory, keyed by site, terrain mode, both heights, t0 and n.
        Returns (list of (series, terrain info) in the order given, t0 aligned to the hour, ephemeris sources)."""
        tab, t0h, src = self.table(t0, n)
        ah = float(lander["power"]["array"]["height_m"])
        eh = float(lander["comms"]["antenna_height_m"])
        out = []
        for loc in locations:
            key = (loc_key(loc), mode, ah, eh, t0h, n)
            with self._slock:
                hit = self._series.get(key)
                if hit is not None:
                    self._series.move_to_end(key)
            if hit is None:
                v, ter = self.view(loc, lander, mode)
                hit = (V.series(v, tab), ter)
                with self._slock:
                    self._series[key] = hit
                    while len(self._series) > self.SERIES_CACHE:
                        self._series.popitem(last=False)
            out.append(hit)
        return out, t0h, src

    # ---------------------------------------------------------------- /sky
    def sky_now(self, loc: Location, t: float, lander: dict, mode: str = "best", dsn: bool = False, min_el: float = 10.0) -> dict:
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
        from .geometry import sub_point
        sp_lat, sp_lon = sub_point(s_vec)
        se_lat, se_lon = sub_point(e_vec)
        dsn_block = None
        if dsn:
            d = self.dsn_at(t, min_el)
            dsn_block = {"min_el_deg": min_el, "stations": d["stations"], "seeing_moon": [x["name"] for x in d["stations"] if x["sees_moon"]],
                         "contact_possible": bool(st["earthClr"] > 0 and d["any_station"]), "sources": d["sources"]}
        return {
            "time": iso(t), "location": loc.as_dict(),
            "vectors_km": {"sun": [float(x) for x in s_vec], "earth": [float(x) for x in e_vec], "frame": "Moon-fixed (body-fixed), from the Moon's centre"},
            "subsolar": {"lat": float(sp_lat), "lon": float(sp_lon)}, "subearth": {"lat": float(se_lat), "lon": float(se_lon)},
            **({"dsn": dsn_block} if dsn else {}),
            "sun": {**body("sun", st["sunFrac"]), "irradiance_factor": f(st["irr"]),
                    "next_sunset": events["sunset"], "next_sunrise": events["sunrise"]},
            "earth": {**body("earth", st["earthFrac"]), "next_earthset": events["earthset"], "next_earthrise": events["earthrise"]},
            "heights": {"array_m": v.array_h, "antenna_m": v.antenna_h, "ground_m": v.ground_m},
            "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)},
        }

    # ---------------------------------------------------------------- /windows
    def windows(self, loc: Location, start: float, end: float, lander: dict, mode: str = "best", step_h: int = 1,
                need_earth: bool = True, series: bool = False, dsn: bool = False, min_el: float = 10.0) -> dict:
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
        if dsn:
            from .dsn import visible_any
            _, el, dsrc = self.dsn().series(t0, n_h)
            stn = visible_any(el[:, ::step_h][:, :n], min_el)
            C = K & stn
            out["intervals"]["contact"] = V.intervals(C, t0, step_h * HOUR)
            out["stats"]["contact_pct"] = 100 * C.sum() / n
            out["stats"]["longest_contact_gap_h"] = V._max_run(~C) * step_h
            out["contact_rule"] = f"Earth above the site's skyline and at least one Deep Space Network station sees the Moon above {min_el:g} deg"
            out["_meta"]["dsn"] = dsrc
            if series:
                out["_dsn_any"] = stn
        for k in out["intervals"].values():
            for iv in k:
                iv["start"], iv["end"] = iso(iv["start"]), iso(iv["end"])
        if series:
            out["series"] = {"time": [iso(t0 + i * step_h * HOUR) for i in range(n)],
                             **{k: np.round(se[k], 5).tolist() for k in V.SERIES_KEYS}}
            if dsn:
                out["series"]["dsn_any_station"] = out.pop("_dsn_any").astype(int).tolist()
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
                      include_skyline: bool = True) -> dict:
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
        if include_skyline:
            out["skyline"] = {"azimuth_step_deg": 360.0 / len(v.sun_mask), "sun": np.round(v.sun_mask, 4).tolist(),
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

    # ================================================================ phase 2
    # ---------------------------------------------------------------- /compare
    COMPARE_COLUMNS = [  # key (as in /windows stats), label (main's compare table), unit, better
        ("sunlit_pct", "Sunlit", "%", "higher"), ("earth_in_view_pct", "Earth in view", "%", "higher"),
        ("both_pct", "Both", "%", "higher"), ("longest_sunlit_h", "Longest sunlit run", "h", "higher"),
        ("longest_dark_h", "Longest night", "h", "lower"), ("longest_radio_gap_h", "Longest Earth gap", "h", "lower"),
        ("power_share_tracking_pct", "Mean solar availability (tracking)", "%", "higher"),
        ("power_share_horizontal_pct", "Mean solar availability (horizontal)", "%", "higher"),
    ]

    @staticmethod
    def window_stats(se: dict, n: int, step_h: int = 1, need_earth: bool = True) -> dict:
        """The stats block of /windows, from a series (shared so /compare returns identical numbers)."""
        st = V.stats(se, 0, n, step_h, need_earth)
        L = se["sunClr"][:n] > 0
        K = se["earthClr"][:n] > 0
        return {"sunlit_pct": st["litPct"], "earth_in_view_pct": st["linkPct"], "both_pct": 100 * (L & K).sum() / n,
                "power_share_tracking_pct": st["pTrack"], "power_share_horizontal_pct": st["pFlat"],
                "longest_sunlit_h": st["maxLitD"] * 24, "longest_dark_h": st["maxDarkD"] * 24,
                "longest_radio_gap_h": st["maxOutD"] * 24, "longest_both_h": st["maxBothD"] * 24,
                "max_sun_elevation_deg": float(se["sunEl"][:n].max()), "max_earth_elevation_deg": float(se["earthEl"][:n].max())}

    def compare(self, locs: list[Location], start: float, end: float, lander: dict, mode: str = "best",
                landing: float | None = None, spec: M.MissionSpec | None = None, panorama: bool = False,
                pano_time: float | None = None) -> dict:
        from . import landing as LW
        if not 2 <= len(locs) <= 8:
            raise ValueError("compare takes 2 to 8 sites or points")
        if end <= start:
            raise ValueError("end must be after start")
        if (end - start) > 400 * 86400:
            raise ValueError("the window is limited to 400 days")
        n_h = int(math.ceil((end - start) / HOUR)) + 1
        res, t0, src = self.series_many(locs, start, n_h, lander, mode)
        stats = [self.window_stats(se, se["n"]) for se, _ in res]
        cols = {k: [float(s[k]) for s in stats] for k, *_ in self.COMPARE_COLUMNS}
        best_by = {}
        for k, _, _, better in self.COMPARE_COLUMNS:
            vals = np.array(cols[k])
            b = vals.max() if better == "higher" else vals.min()
            best_by[k] = [int(i) for i in np.nonzero(np.abs(vals - b) <= 1e-9 * max(1.0, abs(b)))[0]]
        tiers = set()
        sites = []
        for loc, (se, ter) in zip(locs, res):
            tiers.update(ter["tiers"])
            sites.append({**loc.as_dict(), "ground_m": ter["ground_m"], "terrain": ter["tiers"][0] if ter["tiers"] else None, "tiers": ter["tiers"]})
        out = {"start": iso(t0), "end": iso(t0 + (n_h - 1) * HOUR), "samples": n_h, "sites": sites,
               "columns": [{"key": k, "label": lab, "unit": u, "better": b} for k, lab, u, b in self.COMPARE_COLUMNS],
               "stats": cols, "best_by": best_by,
               "note": "best_by lists the best site(s) for each column (indices into sites); the API does not pick an overall winner"}
        if landing is not None:
            spec = spec or M.MissionSpec()
            cfg = M.make_cfg(lander, spec)
            days_h = M.js_round(spec.duration_days * 24)
            vres, tl, src2 = self.series_many(locs, landing, days_h + 1, lander, mode)
            src = {**src, **src2}
            vs = [M.verdict(se, 0, cfg) for se, _ in vres]
            out["verdicts"] = {"landing_time": iso(tl), "duration_days": spec.duration_days,
                               "verdict": [M.VERDICTS[v["state"]] for v in vs], "state": [int(v["state"]) for v in vs],
                               "reasons": [LW.reasons_of(v) for v in vs],
                               "text": [LW.why(v["state"], LW.reasons_of(v), spec.duration_days) for v in vs]}
        if panorama:
            out["panorama"] = self.panorama(locs, pano_time if pano_time is not None else start, lander, mode)
        out["_meta"] = {"terrain": {"dem": mode, "tiers": sorted(tiers)}, "ephemeris": self._eph_sources(src)}
        return out

    def panorama(self, locs: list[Location], t: float, lander: dict, mode: str = "best", naz: int = 180,
                 days: float = 29.5, step_h: int = 6) -> dict:
        """Everything main's same-instant panorama draws: each skyline at naz azimuths, the Sun and Earth now, and their
        paths over the next lunar day at step_h steps."""
        s_vec, e_vec = self.eph.exact(t)
        n = int(days * 24 // step_h) + 1
        tab, t0, _ = self.table(t, (n - 1) * step_h + 1)
        tab = tab[::step_h]
        az = np.arange(naz) * 360.0 / naz
        out = {"time": iso(t), "azimuth_deg": az.tolist(), "path_start": iso(t0), "path_step_h": step_h,
               "path_time": [iso(t0 + k * step_h * HOUR) for k in range(n)], "sites": []}
        r4 = lambda a: np.round(np.asarray(a, dtype=np.float64), 4).tolist()
        for loc in locs:
            v, ter = self.view(loc, lander, mode)
            st = V.state_at(v, s_vec, e_vec)
            pt = V.state_at(v, tab[:, :3], tab[:, 3:])
            out["sites"].append({
                "id": loc.id, "name": loc.name, "ground_m": v.ground_m,
                "skyline_sun_deg": r4(mask_at(v.sun_mask, az)), "skyline_earth_deg": r4(mask_at(v.earth_mask, az)),
                "sun": {"azimuth_deg": float(st["sunAz"]), "elevation_deg": float(st["sunEl"]), "clearance_deg": float(st["sunClr"]),
                        "visible_share": float(st["sunFrac"])},
                "earth": {"azimuth_deg": float(st["earthAz"]), "elevation_deg": float(st["earthEl"]), "clearance_deg": float(st["earthClr"]),
                          "visible_share": float(st["earthFrac"])},
                "sun_path": {"azimuth_deg": r4(pt["sunAz"]), "elevation_deg": r4(pt["sunEl"])},
                "earth_path": {"azimuth_deg": r4(pt["earthAz"]), "elevation_deg": r4(pt["earthEl"])}})
        return out

    # ---------------------------------------------------------------- /map
    def polar_map(self, t: float, layer: str, size: int = 400, dem: str = "best", exact: bool = False):
        from . import polarmap as PM
        from .geometry import sub_point
        if not hasattr(self, "_maps"):
            self._maps = PM.MapService(self.sky.terrain)
        tu = float(t) if exact else round(float(t) / HOUR) * HOUR
        s_vec, e_vec = self.eph.exact(tu)
        vec = e_vec if layer == "earth" else s_vec
        frac, inc, g = self._maps.layer(layer, tu, vec, size, dem)
        sp_lat, sp_lon = sub_point(s_vec)
        se_lat, se_lon = sub_point(e_vec)
        _, _, src = self.table(tu, 1)
        px_m = g["px_km"] * 1000
        half = PM.RHO_KM * 1000
        meta = {"time": iso(tu), "time_requested": iso(t), "rounded_to_hour": not exact, "layer": layer,
                "projection": {"name": "south polar stereographic", "sphere_radius_m": config.R_M, "latitude_limit_deg": PM.CAP,
                               "x_axis": "toward 90E (right in the image)", "y_axis": "toward 0E, the near side (up in the image)",
                               "pixel_to_xy_m": "x = (col + 0.5 - size / 2) * pixel_m, y = (size / 2 - row - 0.5) * pixel_m",
                               "xy_to_latlon": "rho = hypot(x, y); lat = -90 + 2 * atan(rho / (2 * R)) in degrees; lon = atan2(x, y)"},
                "size": size, "pixel_m": px_m, "extent_m": {"xmin": -half, "xmax": half, "ymin": -half, "ymax": half},
                "subsolar": {"lat": float(sp_lat), "lon": float(sp_lon)}, "subearth": {"lat": float(se_lat), "lon": float(se_lon)},
                "body_radius_deg": PM.EARTH_RAD if layer == "earth" else PM.SUN_RAD, "dem": dem, "terrain": g["tier"],
                "_meta": {"terrain": {"dem": dem, "tiers": [g["tier"]]}, "ephemeris": self._eph_sources(src)}}
        return frac, inc, g, meta

    # ---------------------------------------------------------------- /dsn
    def dsn(self):
        """Deep Space Network view on the same store (and Horizons setting) as the ephemeris."""
        if getattr(self, "_dsn", None) is None:
            from .dsn import DsnView
            self._dsn = DsnView(self.store, use_horizons=self.eph.use_horizons)
        return self._dsn

    def dsn_at(self, t: float, min_el: float = 10.0) -> dict:
        from ..prep.dsn import STATIONS
        az, el, src = self.dsn().at(t)
        return {"time": iso(t), "min_el_deg": min_el,
                "stations": [{"name": s[0], "lat": s[1], "lon": s[2], "azimuth_deg": float(az[k]), "elevation_deg": float(el[k]),
                              "sees_moon": bool(el[k] >= min_el)} for k, s in enumerate(STATIONS)],
                "any_station": bool((el >= min_el).any()), "sources": src}

    def dsn_window(self, start: float, end: float, min_el: float = 10.0, series: bool = True) -> dict:
        from ..prep.dsn import STATIONS
        from .dsn import visible_any
        if end <= start:
            raise ValueError("end must be after start")
        if (end - start) > 400 * 86400:
            raise ValueError("the window is limited to 400 days")
        t0 = int(math.floor(start / HOUR)) * HOUR
        n = int(math.ceil((end - t0) / HOUR)) + 1
        az, el, src = self.dsn().series(t0, n)
        out = {"start": iso(t0), "end": iso(t0 + (n - 1) * HOUR), "step_h": 1, "samples": n, "min_el_deg": min_el, "stations": []}
        for k, s in enumerate(STATIONS):
            ok = el[k] >= min_el
            rec = {"name": s[0], "lat": s[1], "lon": s[2], "sees_moon_pct": 100 * ok.sum() / n, "intervals": self._ivs(ok, t0)}
            if series:
                rec["elevation_deg"] = np.round(el[k], 3).tolist()
                rec["azimuth_deg"] = np.round(az[k], 3).tolist()
            out["stations"].append(rec)
        anyv = visible_any(el, min_el)
        out["any_station"] = {"sees_moon_pct": 100 * anyv.sum() / n, "intervals": self._ivs(anyv, t0),
                              "longest_gap_h": int(V._max_run(~anyv))}
        if series:
            out["time"] = [iso(t0 + i * HOUR) for i in range(n)]
        out["sources"] = src
        return out

    @staticmethod
    def _ivs(b: np.ndarray, t0: int, step_s: int = HOUR) -> list[dict]:
        out = V.intervals(np.asarray(b, dtype=bool), t0, step_s)
        for iv in out:
            iv["start"], iv["end"] = iso(iv["start"]), iso(iv["end"])
        return out

    # ---------------------------------------------------------------- /landing-window
    def landing_window(self, plan: Location, plan_time: float, locs: list[Location], lander: dict, spec: M.MissionSpec,
                       slip_days: int = 0, flex_days: int = 21, step_h: int = 6, mode: str = "best",
                       needs_dsn: bool = False, min_el: float = 10.0) -> dict:
        from . import landing as LW
        if not 0 <= flex_days <= 60:
            raise ValueError("flex_days must be between 0 and 60")
        if not 0 <= slip_days <= 365:
            raise ValueError("slip_days must be between 0 and 365")
        if not 1 <= step_h <= 24:
            raise ValueError("step_h must be between 1 and 24")
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        n = (slip_days + flex_days) * 24 + days_h + 1
        if not any(l.id == plan.id and l.lat == plan.lat and l.lon == plan.lon for l in locs):
            locs = [plan] + list(locs)
        res, tP, src = self.series_many(locs, plan_time, n, lander, mode)
        iS = slip_days * 24
        allowed = None
        if needs_dsn:
            from .dsn import visible_any
            _, el, _ = self.dsn().series(tP, n)
            allowed = visible_any(el, min_el)
        pi = next(k for k, l in enumerate(locs) if l.id == plan.id and l.lat == plan.lat and l.lon == plan.lon)
        pse = res[pi][0]
        base = M.verdict(pse, 0, cfg)
        slipped = M.verdict(pse, iS, cfg)
        rows = []
        for loc, (se, ter) in zip(locs, res):
            r = LW.search_site(se, iS, flex_days, cfg, step_h, allowed)
            rows.append((loc, r, ter))
        order = sorted(range(len(rows)), key=lambda k: LW.rank_key(rows[k][1]))
        T = lambda i: tP + i * HOUR
        D = spec.duration_days

        def card(v, i, extra_reasons=None):
            st = v["state"]
            rs = LW.reasons_of(v)
            return {"landing_time": iso(T(i)), "verdict": M.VERDICTS[st], "state": st, "reasons": rs, "text": LW.why(st, rs, D),
                    "nominal": M.summary_of(v["nom"], cfg["capWh"]),
                    "with_terrain_margin": M.summary_of(v["rob"], cfg["capWh"]) if v["rob"] else None}
        sites = []
        for rank, k in enumerate(order):
            loc, r, ter = rows[k]
            v = r["verdict"]
            ok = r["state"] > 0
            lt = iso(T(r["i"])) if ok else None
            q = self._q(loc)
            sites.append({
                "rank": rank + 1, "location": loc.as_dict(), "terrain": ter["tiers"][0] if ter["tiers"] else None,
                "best_landing_time": lt, "extra_wait_days": (r["i"] - iS) / 24 if ok else None,
                "verdict": M.VERDICTS[r["state"]], "state": r["state"], "reasons": r["reasons"],
                "text": LW.why(r["state"], r["reasons"], D),
                "lowest_battery": v["nom"]["minSoc"], "longest_link_gap_h": v["nom"]["maxGapH"],
                "good_landing_days": r["good_days"],
                "windows": [{"start": iso(T(w["first"])), "end": iso(T(w["last"])), "verdict": M.VERDICTS[w["state"]],
                             "landings": w["landings"]} for w in r["windows"]],
                "links": {"report": "/report?" + q + f"&time={lt or iso(T(iS))}",
                          "mission_design": "/mission-design?" + q + f"&landing_time={lt or iso(T(iS))}"},
            })
        n_meet = sum(1 for s in sites if s["state"] == 2)
        n_marg = sum(1 for s in sites if s["state"] == 1)
        from datetime import datetime as _dt
        fd = lambda t: f"{_dt.fromtimestamp(t, timezone.utc).day} {_dt.fromtimestamp(t, timezone.utc).strftime('%b %Y')}"
        summary = (f"Searched {len(sites)} sites for landings between {fd(T(iS))} and {fd(T(iS + flex_days * 24))}, every {step_h} hours: "
                   f"{n_meet} meet the needs with the terrain margin, {n_marg} only without it. Ranked by verdict, then shortest extra wait, "
                   f"then battery margin." + (" Landing times when no Deep Space Network station sees the Moon above "
                                               f"{min_el:g} degrees were dropped." if needs_dsn else ""))
        return {"plan": {"location": plan.as_dict(), **card(base, 0)},
                "after_slip": card(slipped, iS), "slip_days": slip_days, "flex_days": flex_days, "step_h": step_h,
                "search": {"start": iso(T(iS)), "end": iso(T(iS + flex_days * 24)), "needs_dsn_at_landing": needs_dsn,
                           "min_el_deg": min_el if needs_dsn else None},
                "sites": sites, "summary": summary,
                "_meta": {"terrain": {"dem": mode, "tiers": sorted({t for _, _, ter in rows for t in ter["tiers"]})},
                          "ephemeris": self._eph_sources(src)}}

    @staticmethod
    def _q(loc: Location) -> str:
        from urllib.parse import urlencode
        return urlencode({"site": loc.id} if loc.id else {"lat": round(loc.lat, 6), "lon": round(loc.lon, 6)})

    # ---------------------------------------------------------------- /mission-design
    def mission_design(self, loc: Location, landing: float, lander: dict, spec: M.MissionSpec, mode: str = "best",
                       mass_of=(80.0, 160.0)) -> dict:
        from . import design as D
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        res, t0, src = self.series_many([loc], landing, days_h + 1, lander, mode)
        se, ter = res[0]
        i0 = 0
        r = D.lab(se, i0, cfg, mass_of)
        F = r["frontier"]
        b = F["best"]
        shape = M.power_shape(se, cfg)
        v = M.verdict(se, i0, cfg, shape)
        st = int(v["state"])
        wkg, whkg = mass_of
        mine = cfg["peakW"] / wkg + cfg["capWh"] / whkg
        nom = M.mission(se, i0, cfg, 0, True, shape)
        out = {
            "location": loc.as_dict(), "landing_time": iso(t0), "duration_days": spec.duration_days,
            "mass_figures": {"array_w_per_kg": wkg, "battery_wh_per_kg": whkg,
                             "note": "screening values: output and energy divided by W per kg and Wh per kg; structure, wiring, thermal control and margins are not included"},
            "frontier": {"capacity_wh": F["caps"], "min_array_w_robust": F["rob"], "min_array_w_nominal": F["nom"], "array_w_max": F["pMax"],
                         "note": "smallest array that passes for each battery size, with the terrain margin (robust) and without it (nominal); null where no array up to array_w_max passes"},
            "lightest": ({"array_w": b["peakW"], "battery_wh": b["capWh"], "mass_kg": b["mass"],
                          "text": f"{D.fmt_w(b['peakW'])} + {D.fmt_cap(b['capWh'])}, about {D.fmt_kg(b['mass'])} of array and battery."} if b else None),
            "yours": {"array_w": cfg["peakW"], "battery_wh": cfg["capWh"], "verdict": M.VERDICTS[st], "state": st, "mass_kg": mine,
                      "kg_above_lightest": (mine - b["mass"]) if b else None, "reasons": (v["nom"]["fails"] if st == 0 else (v["rob"]["fails"] if st == 1 else []))},
            "fixes": [], "traces": {"time": [iso(t0 + k * HOUR) for k in range(nom["n"] + 1)],
                                    "state_of_charge_yours": np.round(nom["soc"], 5).tolist(), "state_of_charge_lightest": None},
        }
        tail = ""
        if b:
            tail = ((f" · {D.fmt_kg(mine - b['mass'])} more than the lightest" if mine - b["mass"] > 0.05 else " · as light as it gets")
                    if st == 2 else f" · the lightest passing design is {D.fmt_kg(b['mass'])}")
        out["yours"]["text"] = f"{D.fmt_w(cfg['peakW'])} + {D.fmt_cap(cfg['capWh'])}, about {D.fmt_kg(mine)}{tail}"
        if b:
            pa, cb, load = r["min_array_at_your_battery_w"], r["min_battery_at_your_array_wh"], r["max_sunlit_load_w"]
            out["fixes"] = D.fixes(cfg, pa, cb, load, st, mass_of)
            out["fixes_heading"] = "Ways to make " + ("it lighter" if st == 2 else "it pass")
            out["traces"]["state_of_charge_lightest"] = r["best_trace_soc"]
            lean = (mine - b["mass"]) / b["mass"] < 0.15
            out["status_text"] = ("Lean design" if lean else "Passes, with mass to spare") if st == 2 else \
                ("Marginal: needs more hardware" if st == 1 else "Fails: needs more hardware")
            body = LD.deep_merge(lander, {"power": {"array": self._scaled_array(lander["power"]["array"], b["peakW"]),
                                                    "battery": {"capacity_wh": b["capWh"]}}})
            body.update(id=f"design-{loc.id or 'custom'}-{iso(t0)[:10]}", name=f"Lightest design for {loc.name}, landing {iso(t0)[:10]}",
                        source=f"Mons Carlo mission design, derived from {lander.get('id', 'a custom lander')}")
            out["use_this_design"] = {"endpoint": "POST /landers", "body": body,
                                      "note": "the lander with the lightest array and battery; change id and name as you like"}
        else:
            out["why_none"] = r["why_none"]
            out["status_text"] = "No hardware works at this time"
            out["why_none_text"] = (f"No array and battery pass at this landing time, because {r['why_none']}. "
                                    "Try another time in the atlas.")
        if lander["power"]["array"]["type"] == "vertical":
            out["vertical_note"] = ("Vertical array: every face is scaled by the same factor, so array_w here is the total of "
                                    "the faces' peak outputs.")
        out["_meta"] = {"terrain": ter, "ephemeris": self._eph_sources(src)}
        return out

    @staticmethod
    def _scaled_array(arr: dict, total_w: float) -> dict:
        if arr["type"] != "vertical":
            return {"peak_w": total_w}
        tot = sum(f["peak_w"] for f in arr["faces"]) or 1.0
        return {"faces": [{"azimuth_deg": f["azimuth_deg"], "peak_w": round(f["peak_w"] * total_w / tot, 3)} for f in arr["faces"]]}

    def mission_atlas(self, loc: Location, landing: float, lander: dict, spec: M.MissionSpec, mode: str = "best",
                      mass_of=(80.0, 160.0), start: float | None = None, days: float = 60, step_h: int = 12) -> dict:
        from . import design as D
        if not 1 <= days <= 120:
            raise ValueError("days must be between 1 and 120")
        if not 1 <= step_h <= 48:
            raise ValueError("step_h must be between 1 and 48")
        cfg = M.make_cfg(lander, spec)
        days_h = M.js_round(spec.duration_days * 24)
        first = start if start is not None else math.floor(landing / 86400) * 86400 - 5 * 86400
        first = int(math.floor(first / HOUR)) * HOUR
        n_land = int(days * 24 // step_h)
        n_h = (n_land - 1) * step_h + days_h + 1
        res, t0, src = self.series_many([loc], first, n_h, lander, mode)
        se, ter = res[0]
        A = D.atlas(se, 0, cfg, mass_of, n_land, step_h)
        top = D.best_dates([a["mass"] if a else None for a in A], 4, max(1, math.ceil(72 / step_h)))
        q = self._q(loc)
        T = lambda j: iso(t0 + j * step_h * HOUR)
        mine = cfg["peakW"] / mass_of[0] + cfg["capWh"] / mass_of[1]
        best = [{"landing_time": T(j), "array_w": A[j]["peakW"], "battery_wh": A[j]["capWh"], "mass_kg": A[j]["mass"],
                 "kg_vs_yours": A[j]["mass"] - mine, "link": "/mission-design?" + q + f"&landing_time={T(j)}"} for j in top]
        return {"location": loc.as_dict(), "start": iso(t0), "step_h": step_h, "days": days, "duration_days": spec.duration_days,
                "mass_figures": {"array_w_per_kg": mass_of[0], "battery_wh_per_kg": mass_of[1]},
                "time": [T(j) for j in range(n_land)],
                "lightest_mass_kg": [a["mass"] if a else None for a in A], "array_w": [a["peakW"] if a else None for a in A],
                "battery_wh": [a["capWh"] if a else None for a in A],
                "best_dates": best, "your_mass_kg": mine,
                "note": "null where no array and battery pass (for example dark or no Earth at landing). The search is main's lighter frontier: 12 battery sizes, 9 bisection steps, with the terrain margin.",
                "text": (None if best else f"No landing time in these {days:g} days works with any hardware, for this site and these mission needs."),
                "_meta": {"terrain": ter, "ephemeris": self._eph_sources(src)}}
