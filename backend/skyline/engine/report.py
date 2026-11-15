"""/report: everything for a site and date in one call, with a one-sentence plain-language summary."""
from __future__ import annotations

from datetime import datetime, timezone

from . import mission as M
from . import montecarlo as MC
from .service import Engine, iso
from .sites import Location


def _date(t: float) -> str:
    d = datetime.fromtimestamp(t, timezone.utc)
    return f"{d.day} {d.strftime('%b')} {d.year}"


def summary(loc: Location, t: float, sky: dict, win: dict, mis: dict, lander: dict, risk: dict | None) -> str:
    s, e = sky["sun"], sky["earth"]
    if s["above_skyline"]:
        sun = f"the Sun is {s['clearance_deg']:.1f}° above the skyline"
        if s["next_sunset"]["time"]:
            sun += f" and sets in {s['next_sunset']['in_text']}"
    else:
        sun = f"the Sun is {abs(s['clearance_deg']):.1f}° below the skyline"
        if s["next_sunrise"]["time"]:
            sun += f" and rises in {s['next_sunrise']['in_text']}"
    if e["above_skyline"]:
        earth = "Earth is in view" + (f" until Earthset in {e['next_earthset']['in_text']}" if e["next_earthset"]["time"] else "")
    else:
        earth = "Earth is hidden" + (f" until Earthrise in {e['next_earthrise']['in_text']}" if e["next_earthrise"]["time"] else "")
    days = round((win["samples"] - 1) * win["step_h"] / 24)
    st = win["stats"]
    verdict = {"meets": "meets the needs", "marginal": "is marginal (passes only without the terrain margin)", "fails": "fails"}[mis["verdict"]]
    why = f", because {mis['reasons'][0]}" if mis["reasons"] else ""
    text = (f"At {loc.name} on {_date(t)} {sun}; {earth}. Over the next {days} days: sunlit {st['sunlit_pct']:.0f}%, "
            f"Earth in view {st['earth_in_view_pct']:.0f}%, both {st['both_pct']:.0f}%. "
            f"{lander['name']}, {mis['duration_days']:g}-day mission landing then: {verdict}{why}.")
    if risk and risk.get("available"):
        text += f" Landing risk: {100 * risk['success_p']:.0f}% chance of success (95% interval {100 * risk['ci95'][0]:.0f} to {100 * risk['ci95'][1]:.0f}%)."
    return text


def report(eng: Engine, loc: Location, t: float, lander: dict, spec: M.MissionSpec, mode: str, window_days: float,
           include: set[str], unc: MC.Uncertainty | None = None) -> dict:
    sky = eng.sky_now(loc, t, lander, mode)
    win = eng.windows(loc, t, t + window_days * 86400, lander, mode, 1, spec.needs_earth, series="series" in include)
    mis = eng.mission(loc, t, lander, spec, mode, risk="risk" in include, unc=unc, trace="trace" in include)
    out = {"summary": summary(loc, t, sky, win, mis, lander, mis.get("risk")),
           "location": loc.as_dict(), "time": iso(t),
           "sky": {k: sky[k] for k in ("sun", "earth", "heights")},
           "windows": {k: win[k] for k in ("start", "end", "stats")},
           "mission": {k: mis[k] for k in ("landing_time", "duration_days", "verdict", "verdict_text", "reasons", "nominal", "with_terrain_margin")}}
    if "series" in include:
        out["windows"]["series"] = win["series"]
        out["windows"]["intervals"] = win["intervals"]
    if "trace" in include:
        out["mission"]["trace"] = mis["trace"]
    if "risk" in include:
        out["mission"]["risk"] = mis["risk"]
    if "horizon" in include:
        hz = eng.horizon(loc, sorted({lander["power"]["array"]["height_m"], lander["comms"]["antenna_height_m"]}), mode)
        out["horizon"] = hz
    meta_e = {}
    for part in (sky, win, mis):
        meta_e.update(part["_meta"]["ephemeris"])
    out["_meta"] = {"terrain": sky["_meta"]["terrain"], "ephemeris": dict(sorted(meta_e.items()))}
    return out
