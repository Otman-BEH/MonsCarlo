"""Endpoint handlers. GET for everything read-only; the same parameter names as the UI and the CLI."""
from __future__ import annotations

import io
import json
import threading
from typing import Literal, Optional

from fastapi import APIRouter, Body, Query, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import ValidationError

from .. import config
from ..engine import landers as LD
from ..engine import mission as M
from ..engine import montecarlo as MC
from ..engine import report as RP
from ..engine import sites as SI
from ..engine.service import Engine, iso, parse_time
from ..prep import fetch_data, horizons, precompute, spice
from ..prep.store import default_store
from .schemas import MissionRequest, ReportRequest

router = APIRouter()
_engine: Engine | None = None
_elock = threading.Lock()


def engine() -> Engine:
    global _engine
    with _elock:
        if _engine is None:
            _engine = Engine()
        return _engine


def reset_engine():
    global _engine
    with _elock:
        _engine = None


# ---------------------------------------------------------------- helpers
CITATIONS = {
    "jpl-horizons": "JPL Horizons API, https://ssd.jpl.nasa.gov/horizons/ (Giorgini et al.)",
    "spice-de440": "JPL NAIF SPICE kernels DE440, moon_pa_de440_200625.bpc, https://naif.jpl.nasa.gov/pub/naif/generic_kernels/",
    "LOLA 5 m": "Barker et al. 2021, PSS 203, 105119, PGDA product 78, https://pgda.gsfc.nasa.gov/products/78",
    "LOLA 80 m": "Barker et al. 2021, LOLA south polar DEMs, PGDA product 90, https://pgda.gsfc.nasa.gov/products/90",
    "LOLA 240 m": "Barker et al. 2021, LOLA south polar DEMs, PGDA product 90, https://pgda.gsfc.nasa.gov/products/90",
    "LOLA coarse grid": "LOLA global grid as packed in main's build/data.json (build/pack.py, ssa-data-lunar)",
    "LOLA 400 m": "LOLA 80 m DEM averaged to 400 m in main's build/data.json (PGDA product 90)",
}


def _cite(tiers: list[str], eph: dict) -> list[str]:
    keys = set()
    for t in tiers:
        for k in CITATIONS:
            if t.startswith(k):
                keys.add(k)
    for m in eph.values():
        keys.update(m.values())
    return list(dict.fromkeys(CITATIONS[k] for k in sorted(keys) if k in CITATIONS))


def meta(part_meta: dict | None = None, lander: dict | None = None, defaults: list[str] | None = None, **extra) -> dict:
    m = {"api_version": config.API_VERSION}
    if part_meta:
        eph = part_meta.get("ephemeris", {})
        m["sources"] = {"ephemeris": eph, "terrain": part_meta.get("terrain"), "citations": _cite(part_meta.get("terrain", {}).get("tiers", []), eph)}
    if lander is not None:
        m["lander_resolved"] = lander
    if defaults is not None:
        m["defaults_used"] = defaults
    m.update(extra)
    return m


def _loc(site, lat, lon) -> SI.Location:
    return SI.resolve(site, lat, lon)


def _lander_get(lander: Optional[str], flat: dict) -> dict:
    base = LD.resolve(lander or "reference")
    return LD.with_overrides(base, flat)


def _defaults(**given) -> list[str]:
    return [k for k, v in given.items() if v is None or v is False]


def _clean(d: dict) -> dict:
    d = dict(d)
    d.pop("_meta", None)
    return d


LanderQ = Query(None, description="preset or saved lander id (default reference)")
DemQ = Query("best", description="terrain: best (5 m tiles where available) or 80m (main's parity mode)")


def _flat(array_type, array_peak_w, array_height_m, heading_deg, antenna_height_m, battery_wh, min_soc, charge_eff,
          load_sunlit_w, load_dark_w, safe_mode) -> dict:
    return {k: v for k, v in dict(array_type=array_type, array_peak_w=array_peak_w, array_height_m=array_height_m,
                                  heading_deg=heading_deg, antenna_height_m=antenna_height_m, battery_wh=battery_wh, min_soc=min_soc,
                                  charge_eff=charge_eff, load_sunlit_w=load_sunlit_w, load_dark_w=load_dark_w, safe_mode=safe_mode).items() if v is not None}


# ---------------------------------------------------------------- endpoints
@router.get("/health", tags=["data"])
def health():
    st = default_store()
    files = fetch_data.status(st)
    eng = engine()
    terrain = eng.sky.terrain.available()
    cov = eng.eph.coverage()
    stamp = st.stamp(precompute.STEP)
    ok = not files["missing"] and precompute.stamp_ok(st) and (cov["months_cached"] > 0 or spice.available())
    return {"status": "ok" if ok else "degraded", "files": files,
            "precompute": {"ok": precompute.stamp_ok(st), "stamp": stamp, "code_version": config.CODE_VERSION},
            "ephemeris": {**cov, "spice_fallback_available": spice.available(), "primary_source": horizons.SOURCE},
            "terrain": terrain, "meta": meta()}


@router.get("/sites", tags=["catalogue"])
def sites(group: Optional[str] = Query(None, description="South pole | Past landings | Announced targets")):
    eng = engine()
    out = []
    for s in SI.catalogue():
        if group and s["group"].lower() != group.lower():
            continue
        loc = SI.resolve(s["id"])
        out.append({"id": s["id"], "name": s["name"], "group": s["group"], "lat": loc.lat, "lon": loc.lon,
                    "nominal": {"lat": s["lat"], "lon": s["lon"]}, "snapped": loc.snapped,
                    "ground_m": round(float(eng.sky.terrain.ground(loc.lat, loc.lon, "best")), 1),
                    "best_terrain_tier": eng.sky.terrain.best_tier(loc.lat, loc.lon),
                    "note": s["note"] + (" " + s["snap_note"] if s.get("snap_note") else "")})
    return {"sites": out, "meta": meta()}


@router.get("/landers", tags=["landers"])
def landers_list():
    return {"landers": LD.list_all(), "meta": meta()}


@router.get("/landers/{lid}", tags=["landers"])
def landers_get(lid: str):
    return {"lander": LD.get(lid), "preset": LD.is_preset(lid), "meta": meta()}


@router.post("/landers", tags=["landers"], status_code=201)
def landers_post(body: dict = Body(..., examples=[{"base": "reference", "id": "big-battery", "name": "Reference, 5 kWh",
                                                    "power": {"battery": {"capacity_wh": 5000}}}])):
    body = dict(body)
    if "base" in body:
        if not body.get("id"):
            return JSONResponse(status_code=422, content={"detail": "a saved lander needs an id"})
        base = LD.get(body.pop("base"))
        lander = LD.deep_merge(base, body)
        if lander["power"]["array"]["type"] != "vertical":
            lander["power"]["array"]["faces"] = None
    else:
        lander = body
    lander.setdefault("source", "illustrative")
    lander = LD.Lander.model_validate(lander).model_dump()
    if LD.is_preset(lander["id"]):
        return JSONResponse(status_code=409, content={"detail": f"{lander['id']!r} is a preset id"})
    if not default_store().put_lander(lander):
        return JSONResponse(status_code=409, content={"detail": f"a lander called {lander['id']!r} already exists"})
    return {"lander": lander, "meta": meta()}


@router.delete("/landers/{lid}", tags=["landers"], status_code=204)
def landers_delete(lid: str):
    if LD.is_preset(lid):
        return JSONResponse(status_code=409, content={"detail": "presets cannot be deleted"})
    if not default_store().delete_lander(lid):
        raise LD.UnknownLander(lid)
    return Response(status_code=204)


@router.get("/horizon", tags=["sky"])
def horizon(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
            height_m: str = Query("2", description="height above ground in metres, or a comma list such as 2,10"),
            dem: Literal["best", "80m"] = DemQ):
    try:
        hs = [float(h) for h in height_m.split(",") if h.strip()]
    except ValueError:
        raise ValueError("height_m must be a number or a comma list of numbers")
    if not hs or any(h < 0 or h > 1000 for h in hs) or len(hs) > 8:
        raise ValueError("height_m: 1 to 8 values between 0 and 1000")
    loc = _loc(site, lat, lon)
    r = engine().horizon(loc, hs, dem)
    return {**r, "meta": meta({"terrain": {"dem": dem, "tiers": r["tiers"], "ground_m": r["ground_m"]}, "ephemeris": {}})}


@router.get("/sky", tags=["sky"], summary="Sun and Earth against the skyline now (the challenge's core question)")
def sky(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
        time: Optional[str] = Query(None, description="ISO 8601 UTC, default now"), lander: Optional[str] = LanderQ,
        array_height_m: Optional[float] = Query(None, ge=0, le=100), antenna_height_m: Optional[float] = Query(None, ge=0, le=100),
        dem: Literal["best", "80m"] = DemQ):
    loc = _loc(site, lat, lon)
    t = parse_time(time)
    ld = _lander_get(lander, _flat(None, None, array_height_m, None, antenna_height_m, None, None, None, None, None, None))
    r = engine().sky_now(loc, t, ld, dem)
    return {**_clean(r), "meta": meta(r["_meta"], ld, _defaults(time=time, lander=lander))}


@router.get("/windows", tags=["sky"], summary="Sunlit, Earth-in-view and both-at-once intervals over a period")
def windows(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
            start: Optional[str] = Query(None, description="default now"), end: Optional[str] = Query(None, description="default start + 30 days"),
            step_h: int = Query(1, ge=1, le=24), lander: Optional[str] = LanderQ,
            array_height_m: Optional[float] = Query(None, ge=0, le=100), antenna_height_m: Optional[float] = Query(None, ge=0, le=100),
            needs_earth: bool = True, series: bool = False, format: Literal["json", "csv"] = "json", dem: Literal["best", "80m"] = DemQ):
    loc = _loc(site, lat, lon)
    t0 = parse_time(start)
    t1 = parse_time(end, default=t0 + 30 * 86400)
    ld = _lander_get(lander, _flat(None, None, array_height_m, None, antenna_height_m, None, None, None, None, None, None))
    r = engine().windows(loc, t0, t1, ld, dem, step_h, needs_earth, series=series or format == "csv")
    if format == "csv":
        import pandas as pd
        df = pd.DataFrame(r["series"])
        buf = io.StringIO()
        df.to_csv(buf, index=False, float_format="%.5f")
        return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="windows_{loc.id or "custom"}.csv"'})
    return {**_clean(r), "meta": meta(r["_meta"], ld, _defaults(start=start, end=end, lander=lander))}


@router.get("/mission", tags=["mission"], summary="Mission verdict, quick form (reference lander plus flat overrides)")
def mission_get(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
                landing_time: Optional[str] = Query(None, description="ISO 8601 UTC, default now"), lander: Optional[str] = LanderQ,
                array_type: Optional[Literal["tracking", "horizontal", "vertical"]] = None, array_peak_w: Optional[float] = Query(None, ge=0),
                array_height_m: Optional[float] = Query(None, ge=0, le=100), heading_deg: Optional[float] = None,
                antenna_height_m: Optional[float] = Query(None, ge=0, le=100), battery_wh: Optional[float] = Query(None, gt=0),
                min_soc: Optional[float] = Query(None, ge=0, lt=1), charge_eff: Optional[float] = Query(None, gt=0, le=1),
                load_sunlit_w: Optional[float] = Query(None, ge=0), load_dark_w: Optional[float] = Query(None, ge=0), safe_mode: Optional[bool] = None,
                duration_days: float = Query(10, gt=0, le=60), needs_earth: bool = True, max_gap_h: float = Query(12, ge=0),
                autonomy_h: float = Query(6, ge=0), terrain_margin_deg: float = Query(0.3, ge=0, le=10),
                fault_kind: Literal["none", "array", "battery", "load", "antenna"] = "none", fault_day: float = Query(3, ge=0),
                risk: bool = False, seed: int = Query(20261114, ge=1), trace: bool = False, dem: Literal["best", "80m"] = DemQ):
    loc = _loc(site, lat, lon)
    t = parse_time(landing_time)
    ld = _lander_get(lander, _flat(array_type, array_peak_w, array_height_m, heading_deg, antenna_height_m, battery_wh, min_soc,
                                   charge_eff, load_sunlit_w, load_dark_w, safe_mode))
    spec = M.MissionSpec(duration_days=duration_days, needs_earth=needs_earth, max_gap_h=max_gap_h, autonomy_h=autonomy_h,
                         terrain_margin_deg=terrain_margin_deg, fault=M.Fault(kind=fault_kind, day=fault_day))
    unc = MC.Uncertainty(seed=seed)
    r = engine().mission(loc, t, ld, spec, dem, risk=risk, unc=unc, trace=trace)
    extra = {"seed": seed} if risk else {}
    return {**_clean(r), "meta": meta(r["_meta"], ld, _defaults(landing_time=landing_time, lander=lander), **extra)}


@router.post("/mission", tags=["mission"], summary="Mission verdict, full form (nested lander, mission, uncertainty)")
def mission_post(req: MissionRequest):
    loc = _loc(req.location.site, req.location.lat, req.location.lon)
    t = parse_time(req.landing_time)
    ld = LD.resolve(req.lander)
    r = engine().mission(loc, t, ld, req.mission, req.dem, risk=req.risk, unc=req.uncertainty, trace="trace" in req.include)
    extra = {"seed": req.uncertainty.seed} if req.risk else {}
    return {**_clean(r), "meta": meta(r["_meta"], ld, _defaults(landing_time=req.landing_time, lander=req.lander), **extra)}


def _report(loc, t, ld, spec, dem, window_days, include, unc, given) -> dict:
    r = RP.report(engine(), loc, t, ld, spec, dem, window_days, include, unc)
    r["details"] = {k: f"/{k}?" + q for k, q in (
        ("sky", _q(loc, time=iso(t))), ("windows", _q(loc, start=iso(t), end=iso(t + window_days * 86400))),
        ("mission", _q(loc, landing_time=iso(t), lander=ld["id"] if LD.is_preset(ld["id"]) else None)), ("horizon", _q(loc)))}
    extra = {"seed": unc.seed} if "risk" in include else {}
    return {**_clean(r), "meta": meta(r["_meta"], ld, _defaults(**given), **extra)}


def _q(loc: SI.Location, **kw) -> str:
    from urllib.parse import urlencode
    p = {"site": loc.id} if loc.id else {"lat": loc.lat, "lon": loc.lon}
    p.update({k: v for k, v in kw.items() if v is not None})
    return urlencode(p)


@router.get("/report", tags=["report"], summary="Everything for a site and date in one call")
def report_get(site: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None,
               time: Optional[str] = Query(None, description="default now"), window_days: float = Query(30, gt=0, le=400),
               lander: Optional[str] = LanderQ, duration_days: float = Query(10, gt=0, le=60),
               include: str = Query("", description="comma list: series, horizon, risk, trace"), seed: int = Query(20261114, ge=1),
               dem: Literal["best", "80m"] = DemQ):
    loc = _loc(site, lat, lon)
    t = parse_time(time)
    inc = {s.strip() for s in include.split(",") if s.strip()}
    bad = inc - {"series", "horizon", "risk", "trace"}
    if bad:
        raise ValueError(f"unknown include: {', '.join(sorted(bad))}")
    ld = LD.resolve(lander or "reference")
    return _report(loc, t, ld, M.MissionSpec(duration_days=duration_days), dem, window_days, inc, MC.Uncertainty(seed=seed),
                   dict(time=time, lander=lander))


@router.post("/report", tags=["report"])
def report_post(req: ReportRequest):
    loc = _loc(req.location.site, req.location.lat, req.location.lon)
    t = parse_time(req.time)
    ld = LD.resolve(req.lander)
    return _report(loc, t, ld, req.mission, req.dem, req.window_days, set(req.include), req.uncertainty, dict(time=req.time, lander=req.lander))
