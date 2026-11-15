"""Phase 2 endpoints: pick a site (/map, /compare), pick a time and keep contact (/dsn, /landing-window), size the
lander (/mission-design, /mission-design/atlas). GET for everything read-only, with the same parameter names as the CLI;
POST takes the nested form like POST /mission."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, Response

from .. import config
from ..engine import landers as LD
from ..engine import mission as M
from ..engine import sites as SI
from ..engine.service import iso, parse_time
from .routes import DemQ, LanderQ, _clean, _flat, _lander_get, _loc, engine, meta
from .schemas import LandingWindowRequest, MissionDesignRequest

router = APIRouter()


# ---------------------------------------------------------------- shared query parameters
@dataclass
class LanderMission:
    lander: dict
    spec: M.MissionSpec
    defaults: list = field(default_factory=list)


def lander_mission_q(
        lander: Optional[str] = LanderQ,
        array_type: Optional[Literal["tracking", "horizontal", "vertical"]] = None, array_peak_w: Optional[float] = Query(None, ge=0),
        array_height_m: Optional[float] = Query(None, ge=0, le=100), heading_deg: Optional[float] = None,
        antenna_height_m: Optional[float] = Query(None, ge=0, le=100), battery_wh: Optional[float] = Query(None, gt=0),
        min_soc: Optional[float] = Query(None, ge=0, lt=1), charge_eff: Optional[float] = Query(None, gt=0, le=1),
        load_sunlit_w: Optional[float] = Query(None, ge=0), load_dark_w: Optional[float] = Query(None, ge=0), safe_mode: Optional[bool] = None,
        duration_days: Optional[float] = Query(None, gt=0, le=60, description="default 10"), needs_earth: Optional[bool] = Query(None, description="default true"),
        max_gap_h: Optional[float] = Query(None, ge=0, description="default 12"), autonomy_h: Optional[float] = Query(None, ge=0, description="default 6"),
        terrain_margin_deg: Optional[float] = Query(None, ge=0, le=10, description="default 0.3"),
        fault_kind: Literal["none", "array", "battery", "load", "antenna"] = "none", fault_day: float = Query(3, ge=0)) -> LanderMission:
    """The reference lander plus flat overrides, and the mission fields, exactly as GET /mission takes them."""
    ld = _lander_get(lander, _flat(array_type, array_peak_w, array_height_m, heading_deg, antenna_height_m, battery_wh, min_soc,
                                   charge_eff, load_sunlit_w, load_dark_w, safe_mode))
    given = dict(duration_days=duration_days, needs_earth=needs_earth, max_gap_h=max_gap_h, autonomy_h=autonomy_h,
                 terrain_margin_deg=terrain_margin_deg)
    spec = M.MissionSpec(**{k: v for k, v in given.items() if v is not None}, fault=M.Fault(kind=fault_kind, day=fault_day))
    defaults = (["lander"] if lander is None else []) + [k for k, v in given.items() if v is None]
    return LanderMission(ld, spec, defaults)


def _parse_points(points: Optional[str]) -> list[SI.Location]:
    if not points:
        return []
    out = []
    for p in points.split(";"):
        p = p.strip()
        if not p:
            continue
        try:
            la, lo = (float(v) for v in p.split(","))
        except ValueError:
            raise ValueError(f"points: {p!r} is not lat,lon (use ; between points, for example -89.45,222.7;-85.4,31.6)")
        out.append(SI.resolve(None, la, lo))
    return out


def _parse_sites(sites: Optional[str]) -> list[SI.Location]:
    return [SI.resolve(s.strip()) for s in (sites or "").split(",") if s.strip()]


def _q(loc: SI.Location) -> str:
    return engine()._q(loc)


def _mass(ld: dict, w: Optional[float], wh: Optional[float]) -> tuple[tuple[float, float], list[str]]:
    """Mass figures: the query value, else the lander's mass block, else main's 80 W/kg and 160 Wh/kg."""
    m = ld.get("mass") or {}
    used = []
    if w is None:
        w = m.get("array_w_per_kg")
        if w is None:
            w = 80.0
            used.append("array_w_per_kg (main's 80 W/kg)")
        else:
            used.append("array_w_per_kg (from the lander's mass block)")
    if wh is None:
        wh = m.get("battery_wh_per_kg")
        if wh is None:
            wh = 160.0
            used.append("battery_wh_per_kg (main's 160 Wh/kg)")
        else:
            used.append("battery_wh_per_kg (from the lander's mass block)")
    return (float(w), float(wh)), used


# ---------------------------------------------------------------- /map
@router.get("/map", tags=["pick a site"], summary="Sunlight and Earth-view map of the south pole (80S to the pole)",
            responses={200: {"content": {"image/png": {}, "application/json": {}}}})
def polar_map(time: Optional[str] = Query(None, description="ISO 8601 UTC, default now; rounded to the hour unless exact=true"),
              layer: Literal["sun", "earth"] = "sun", size: int = Query(400, ge=100, le=1200, description="pixels across (400 = main's grid, 1.52 km pixels)"),
              format: Literal["png", "json"] = "png", sites: bool = Query(False, description="add the pixel positions of the catalogue sites"),
              hillshade: bool = Query(False, description="json: add the hillshade grid the PNG is shaded with"),
              exact: bool = False, dem: Literal["best", "80m"] = DemQ):
    from ..engine import polarmap as PM
    t = parse_time(time)
    frac, inc, g, info = engine().polar_map(t, layer, size, dem, exact)
    m = meta(info.pop("_meta"), None, [k for k, v in dict(time=time).items() if v is None], projection=info["projection"],
             pixel_m=info["pixel_m"], size=size)
    site_list = None
    if sites:
        site_list = []
        for s in SI.catalogue():
            loc = SI.resolve(s["id"])
            if loc.lat > PM.CAP:
                continue
            c, r = PM.pixel_of(size, loc.lat, loc.lon)
            site_list.append({"id": loc.id, "name": loc.name, "lat": loc.lat, "lon": loc.lon, "col": c, "row": r,
                              "visible_share": float(frac[min(size - 1, max(0, int(round(r)))), min(size - 1, max(0, int(round(c))))]),
                              "report": f"/report?site={loc.id}&time={info['time']}"})
    if format == "png":
        body = PM.png(PM.colour(g, layer, frac, inc))
        hdr = {"X-Map-Time": info["time"], "X-Map-Layer": layer, "X-Map-Size": str(size), "X-Map-Pixel-M": f"{info['pixel_m']:.3f}",
               "X-Map-Half-Width-M": f"{info['extent_m']['xmax']:.3f}", "X-Map-Subsolar": f"{info['subsolar']['lat']:.4f},{info['subsolar']['lon']:.4f}",
               "X-Map-Subearth": f"{info['subearth']['lat']:.4f},{info['subearth']['lon']:.4f}", "Cache-Control": "public, max-age=3600",
               "Access-Control-Expose-Headers": "X-Map-Time, X-Map-Layer, X-Map-Size, X-Map-Pixel-M, X-Map-Half-Width-M, X-Map-Subsolar, X-Map-Subearth"}
        return Response(content=body, media_type="image/png", headers=hdr)
    out = {**info, "grid": {"encoding": "base64 of uint8, row-major from the top-left pixel; value / 255 = share",
                            "visible_share": PM.b64u8(frac)}}
    out["grid"]["inside"] = "pixels with hypot(x, y) > the half-width are outside the map (value 0)"
    if layer == "sun":
        out["grid"]["incidence"] = PM.b64u8(inc)
        out["grid"]["incidence_note"] = "sine of the Sun's elevation above the local slope, 0 to 1"
    if hillshade:
        out["grid"]["hillshade"] = PM.b64u8(g["hill"])
    if site_list is not None:
        out["sites"] = site_list
    return {**out, "meta": m}


# ---------------------------------------------------------------- /compare
@router.get("/compare", tags=["pick a site"], summary="Site compare: the same statistics side by side for 2 to 8 sites or points")
def compare(sites: Optional[str] = Query(None, description="comma list of site ids, for example shack,ridge,mala"),
            points: Optional[str] = Query(None, description="custom points lat,lon separated by ;, for example -89.45,222.7;-85.4,31.6"),
            start: Optional[str] = Query(None, description="default now"), end: Optional[str] = Query(None, description="default start + 30 days"),
            landing_time: Optional[str] = Query(None, description="add the mission verdict at this landing time for each site"),
            include: str = Query("", description="panorama: each site's skyline and the Sun and Earth paths for one instant"),
            time: Optional[str] = Query(None, description="panorama instant (default start)"),
            lm: LanderMission = Depends(lander_mission_q), dem: Literal["best", "80m"] = DemQ):
    locs = _parse_sites(sites) + _parse_points(points)
    inc = {s.strip() for s in include.split(",") if s.strip()}
    if inc - {"panorama"}:
        raise ValueError(f"unknown include: {', '.join(sorted(inc - {'panorama'}))}")
    t0 = parse_time(start)
    t1 = parse_time(end, default=t0 + 30 * 86400)
    r = engine().compare(locs, t0, t1, lm.lander, dem, landing=parse_time(landing_time) if landing_time else None, spec=lm.spec,
                         panorama="panorama" in inc, pano_time=parse_time(time) if time else None)
    for s in r["sites"]:
        loc = SI.resolve(s["id"]) if s["id"] else SI.resolve(None, s["lat"], s["lon"])
        s["links"] = {"report": "/report?" + _q(loc) + f"&time={r['start']}", "windows": "/windows?" + _q(loc) + f"&start={r['start']}&end={r['end']}"}
    return {**_clean(r), "meta": meta(r["_meta"], lm.lander, [k for k, v in dict(start=start, end=end).items() if v is None] + lm.defaults)}


# ---------------------------------------------------------------- /landing-window
def _landing(plan, plan_time, locs, ld, spec, slip, flex, step_h, dem, needs_dsn, min_el, defaults):
    r = engine().landing_window(plan, parse_time(plan_time), locs, ld, spec, slip, flex, step_h, dem, needs_dsn, min_el)
    return {**_clean(r), "meta": meta(r["_meta"], ld, defaults)}


def _scope(scope: str) -> list[SI.Location]:
    if scope == "all":
        return [SI.resolve(s["id"]) for s in SI.catalogue()]
    return [SI.resolve(s["id"]) for s in SI.catalogue() if s["lat"] <= -80]


@router.get("/landing-window", tags=["pick a time"], summary="Landing window: the best landing times at many sites, also after a schedule slip")
def landing_window_get(site: Optional[str] = Query(None, description="the plan's site"), lat: Optional[float] = None, lon: Optional[float] = None,
                       plan_time: Optional[str] = Query(None, description="the plan's landing time, ISO 8601 UTC; default now"),
                       slip_days: int = Query(0, ge=0, le=365, description="0 answers 'when are the next landing windows here?'; main's default was 14"),
                       flex_days: int = Query(21, ge=0, le=60, description="how many days after the slipped date to search"),
                       scope: Literal["pole", "all"] = Query("pole", description="pole: every site at or below 80S (main's default); all: every site"),
                       sites: Optional[str] = Query(None, description="comma list of site ids to search instead of scope"),
                       step_h: int = Query(6, ge=1, le=24), needs_dsn_at_landing: bool = False, min_el_deg: float = Query(10, ge=0, le=90),
                       lm: LanderMission = Depends(lander_mission_q), dem: Literal["best", "80m"] = DemQ):
    plan = _loc(site, lat, lon)
    locs = _parse_sites(sites) if sites else _scope(scope)
    return _landing(plan, plan_time, locs, lm.lander, lm.spec, slip_days, flex_days, step_h, dem, needs_dsn_at_landing, min_el_deg,
                    [k for k, v in dict(plan_time=plan_time).items() if v is None] + lm.defaults)


@router.post("/landing-window", tags=["pick a time"], summary="Landing window, nested form")
def landing_window_post(req: LandingWindowRequest):
    plan = _loc(req.plan.site, req.plan.lat, req.plan.lon)
    locs = [_loc(s.site, s.lat, s.lon) for s in req.sites] if req.sites else _scope(req.scope)
    ld = LD.resolve(req.lander)
    return _landing(plan, req.plan_time, locs, ld, req.mission, req.slip_days, req.flex_days, req.step_h, req.dem,
                    req.needs_dsn_at_landing, req.min_el_deg, [k for k, v in dict(plan_time=req.plan_time, lander=req.lander).items() if v is None])


# ---------------------------------------------------------------- /mission-design
def _design(loc, t, ld, spec, dem, w, wh, defaults):
    mass_of, used = _mass(ld, w, wh)
    r = engine().mission_design(loc, t, ld, spec, dem, mass_of)
    q = _q(loc)
    r["links"] = {"atlas": "/mission-design/atlas?" + q + f"&landing_time={r['landing_time']}",
                  "mission": "/mission?" + q + f"&landing_time={r['landing_time']}"}
    return {**_clean(r), "meta": meta(r["_meta"], ld, defaults + used)}


def _atlas(loc, t, ld, spec, dem, w, wh, start, days, step_h, defaults):
    mass_of, used = _mass(ld, w, wh)
    r = engine().mission_atlas(loc, t, ld, spec, dem, mass_of, parse_time(start) if start else None, days, step_h)
    return {**_clean(r), "meta": meta(r["_meta"], ld, defaults + used + ([] if start else ["start (5 days before the landing day)"]))}


@router.get("/mission-design", tags=["size the lander"], summary="Mission design: the lightest array and battery that survive, with fixes")
def mission_design_get(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
                       landing_time: Optional[str] = Query(None, description="ISO 8601 UTC, default now"),
                       array_w_per_kg: Optional[float] = Query(None, ge=5, le=500, description="default: the lander's mass block, else 80"),
                       battery_wh_per_kg: Optional[float] = Query(None, ge=20, le=500, description="default: the lander's mass block, else 160"),
                       lm: LanderMission = Depends(lander_mission_q), dem: Literal["best", "80m"] = DemQ):
    return _design(_loc(site, lat, lon), parse_time(landing_time), lm.lander, lm.spec, dem, array_w_per_kg, battery_wh_per_kg,
                   [k for k, v in dict(landing_time=landing_time).items() if v is None] + lm.defaults)


@router.post("/mission-design", tags=["size the lander"], summary="Mission design, nested form")
def mission_design_post(req: MissionDesignRequest):
    ld = LD.resolve(req.lander)
    return _design(_loc(req.location.site, req.location.lat, req.location.lon), parse_time(req.landing_time), ld, req.mission, req.dem,
                   req.array_w_per_kg, req.battery_wh_per_kg, [k for k, v in dict(landing_time=req.landing_time, lander=req.lander).items() if v is None])


@router.get("/mission-design/atlas", tags=["size the lander"], summary="Opportunity atlas: the lightest design for a landing every 12 h over 60 days")
def atlas_get(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
              landing_time: Optional[str] = Query(None, description="ISO 8601 UTC, default now"),
              start: Optional[str] = Query(None, description="first landing time (default 5 days before the landing day)"),
              days: float = Query(60, ge=1, le=120), step_h: int = Query(12, ge=1, le=48),
              array_w_per_kg: Optional[float] = Query(None, ge=5, le=500), battery_wh_per_kg: Optional[float] = Query(None, ge=20, le=500),
              lm: LanderMission = Depends(lander_mission_q), dem: Literal["best", "80m"] = DemQ):
    return _atlas(_loc(site, lat, lon), parse_time(landing_time), lm.lander, lm.spec, dem, array_w_per_kg, battery_wh_per_kg, start, days,
                  step_h, [k for k, v in dict(landing_time=landing_time).items() if v is None] + lm.defaults)


@router.post("/mission-design/atlas", tags=["size the lander"], summary="Opportunity atlas, nested form")
def atlas_post(req: MissionDesignRequest):
    ld = LD.resolve(req.lander)
    return _atlas(_loc(req.location.site, req.location.lat, req.location.lon), parse_time(req.landing_time), ld, req.mission, req.dem,
                  req.array_w_per_kg, req.battery_wh_per_kg, req.start, req.days, req.step_h,
                  [k for k, v in dict(landing_time=req.landing_time, lander=req.lander).items() if v is None])
