"""Hour-by-hour battery and link simulation and the mission verdict. Port of main's src/analysis.js (fracAt, mission,
verdict, causeOf, CAUSES), extended with the power models in engine.power.

Verdict: 2 = meets the needs (passes with the terrain margin), 1 = marginal (passes only without it), 0 = fails.
"""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from . import power

SUNR = 0.266
CAUSES = ["Dark at landing", "No Earth line of sight at landing", "Battery too low", "Link gap too long", "Ground too steep", "Other"]
CAUSE_KEYS = ["dark_at_landing", "no_earth_at_landing", "battery_too_low", "link_gap_too_long", "ground_too_steep", "other"]
VERDICTS = {2: "meets", 1: "marginal", 0: "fails"}
VERDICT_TEXT = {2: "Meets the needs", 1: "Marginal: passes only without the terrain margin", 0: "Does not meet the needs"}


class Fault(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["none", "array", "battery", "load", "antenna"] = "none"
    day: float = Field(default=3, ge=0, le=365)


class MissionSpec(BaseModel):
    """What is asked of the lander. landing_time is supplied separately by the caller."""
    model_config = ConfigDict(extra="forbid")
    duration_days: float = Field(default=10, gt=0, le=60)
    needs_earth: bool = True
    max_gap_h: float = Field(default=12, ge=0, le=10000)
    autonomy_h: float = Field(default=6, ge=0, le=1000, description="blackout rule: at its lowest charge the battery must still carry the dark load this long")
    terrain_margin_deg: float = Field(default=0.3, ge=0, le=10)
    fault: Fault = Fault()


# ---------------------------------------------------------------- JS-compatible formatting
def js_round(x: float) -> int:
    return int(math.floor(x + 0.5))


def js_fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: exact binary value, ties go to the larger magnitude."""
    if not math.isfinite(x):
        return "NaN" if math.isnan(x) else ("Infinity" if x > 0 else "-Infinity")
    q = Decimal(1).scaleb(-digits)
    s = str(Decimal(abs(x)).quantize(q, rounding=ROUND_HALF_UP))
    return ("-" + s) if x < 0 and float(s) != 0 else s


def js_num(x: float) -> str:
    if float(x).is_integer():
        return str(int(x))
    return repr(float(x))


# ---------------------------------------------------------------- configuration
def make_cfg(lander: dict, spec: MissionSpec | dict) -> dict:
    """Flatten lander + mission into main's cfg shape (plus the array model)."""
    m = spec if isinstance(spec, MissionSpec) else MissionSpec.model_validate(spec or {})
    p = lander["power"]
    arr = p["array"]
    return {
        "days": m.duration_days, "peakW": power.total_peak_w(arr), "loadSun": p["loads"]["sunlit_w"], "loadDark": p["loads"]["dark_w"],
        "capWh": p["battery"]["capacity_wh"], "minSoc": p["battery"]["min_soc"], "chargeEff": p["battery"]["charge_eff"],
        "tracking": arr["type"] == "tracking", "array": arr, "needEarth": m.needs_earth, "maxGapH": m.max_gap_h,
        "margin": m.terrain_margin_deg, "fault": m.fault.model_dump(), "safe": p["safe_mode"], "autonomyH": m.autonomy_h,
    }


def power_shape(se: dict, cfg: dict) -> np.ndarray:
    """Per-hour array output per watt of peak, before irradiance and disc fraction."""
    arr = cfg.get("array") or {"type": "tracking" if cfg.get("tracking", True) else "horizontal", "peak_w": cfg["peakW"]}
    if arr["type"] == "horizontal":
        # exactly main's expression: Math.max(0, Math.sin(sunEl * PI / 180)) on the float32 series value
        return np.maximum(0.0, np.sin(se["sunEl"] * math.pi / 180))
    return power.shape(arr, se["sunEl"], se["sunAz"])


def frac_at(se: dict, i, margin):
    d = (se["sunClr"][i] - margin) / (se["sunRad"][i] if "sunRad" in se else SUNR)
    dc = np.clip(d, -1, 1)
    f = 1 - (np.arccos(dc) - dc * np.sqrt(1 - dc * dc)) / math.pi
    return np.where(d >= 1, 1.0, np.where(d <= -1, 0.0, f))


def _frac1(se, i, margin) -> float:
    d = (float(se["sunClr"][i]) - margin) / (float(se["sunRad"][i]) if "sunRad" in se else SUNR)
    if d >= 1:
        return 1.0
    if d <= -1:
        return 0.0
    return 1 - (math.acos(d) - d * math.sqrt(1 - d * d)) / math.pi


# ---------------------------------------------------------------- the simulation
def mission(se: dict, i0: int, cfg: dict, margin: float, keep: bool = False, shape: np.ndarray | None = None) -> dict:
    """Port of Ana.mission. Scalar loop, so fail messages and traces match main exactly."""
    n_ser = se["n"]
    want = js_round(cfg["days"] * 24)
    n = max(0, min(want, n_ser - i0))
    cap = cfg["capWh"]
    floor = cfg["minSoc"] * cap
    E = cap
    minE = cap
    kMin = 0
    gap = maxGap = dark = maxDark = linkH = litH = 0
    draw = maxDraw = 0.0
    kFail = -1
    F = cfg["fault"] if cfg.get("fault") and cfg["fault"]["kind"] != "none" else None
    fk = js_round(F["day"] * 24) if F else 10 ** 9
    capNow = cap
    safe = False
    safeH = 0
    shp = power_shape(se, cfg) if shape is None else shape
    irr, eclr = se["irr"], se["earthClr"]
    soc = np.zeros(n + 1, dtype=np.float32) if keep else None
    sun = np.zeros(n, dtype=np.float32) if keep else None
    link = np.zeros(n, dtype=np.uint8) if keep else None
    safe_arr = np.zeros(n, dtype=np.uint8) if keep else None
    if keep:
        soc[0] = 1
    peak, lsun, ldark, eff = cfg["peakW"], cfg["loadSun"], cfg["loadDark"], cfg["chargeEff"]
    need_e = cfg["needEarth"]
    for k in range(n):
        i = i0 + k
        f = _frac1(se, i, margin)
        on = k >= fk
        p = peak * float(irr[i]) * f * float(shp[i]) * (0.7 if (on and F["kind"] == "array") else 1)
        if on and F["kind"] == "battery" and capNow == cap:
            capNow = cap * 0.75
            if E > capNow:
                E = capNow
        load = lsun if f > 0.02 else ldark
        if cfg["safe"]:
            if not safe and E < 0.4 * capNow:
                safe = True
            elif safe and E > 0.7 * capNow:
                safe = False
            if safe:
                load = min(load, ldark)
                safeH += 1
        if on and F["kind"] == "load":
            load += 100
        net = p - load
        dE = net * eff if net > 0 else net
        E = min(capNow, E + dE)
        if E < minE:
            minE = E
            kMin = k + 1
        if E < floor and kFail < 0:
            kFail = k + 1
        draw = min(0.0, draw + dE)
        if -draw > maxDraw:
            maxDraw = -draw
        L = (float(eclr[i]) - margin > 0) and not (on and F["kind"] == "antenna" and k < fk + 24)
        if L:
            linkH += 1
            gap = 0
        else:
            gap += 1
            if gap > maxGap:
                maxGap = gap
        if f > 0.5:
            litH += 1
            dark = 0
        else:
            dark += 1
            if dark > maxDark:
                maxDark = dark
        if keep:
            soc[k + 1] = max(0.0, E / cap)
            sun[k] = f
            link[k] = 1 if L else 0
            safe_arr[k] = 1 if safe else 0
    fails = []
    if n < want:
        fails.append("the ephemeris window ends before the mission does")
    if n > 0 and _frac1(se, i0, margin) <= 0.5:
        fails.append("the Sun is not up at landing")
    if need_e and n > 0 and not (float(eclr[i0]) - margin > 0):
        fails.append("no Earth line of sight at landing")
    if not math.isfinite(E) or not math.isfinite(minE):
        fails.append("the mission inputs are not valid numbers")
    if minE < floor:
        fails.append(f"battery falls to {max(0, js_round(100 * minE / cap))}% on day {js_fixed(kMin / 24, 1)}")
    autoWh = (cfg.get("autonomyH") or 0) * ldark
    if autoWh > 0 and minE >= floor and minE - floor < autoWh:
        fails.append(f"battery cannot ride out a {js_num(cfg['autonomyH'])} h blackout (its lowest charge covers {js_fixed((minE - floor) / max(1e-9, ldark), 1)} h)")
    if need_e and maxGap > cfg["maxGapH"]:
        g = js_fixed(maxGap / 24, 1) + " d" if maxGap >= 48 else f"{maxGap} h"
        fails.append(f"Earth is out of view for {g} (limit {js_num(cfg['maxGapH'])} h)")
    usable = (0.75 if (F and F["kind"] == "battery") else 1.0) - cfg["minSoc"]
    return {"ok": len(fails) == 0, "fails": fails, "minSoc": max(0.0, minE / cap), "kMin": kMin, "kFail": kFail, "maxGapH": maxGap,
            "maxDarkH": maxDark, "linkPct": 100 * linkH / n if n else 0.0, "litPct": 100 * litH / n if n else 0.0,
            "battNeedWh": (maxDraw + autoWh) / usable if usable > 0 else math.inf, "n": n,
            "soc": soc, "sun": sun, "link": link, "safeH": safeH, "safeArr": safe_arr, "faultK": fk if F else -1}


def verdict(se: dict, i0: int, cfg: dict, shape: np.ndarray | None = None) -> dict:
    shp = power_shape(se, cfg) if shape is None else shape
    nom = mission(se, i0, cfg, 0, False, shp)
    if not nom["ok"]:
        return {"state": 0, "nom": nom, "rob": None}
    rob = mission(se, i0, cfg, cfg["margin"], False, shp)
    return {"state": 2 if rob["ok"] else 1, "nom": nom, "rob": rob}


def cause_of(f: str) -> int:
    if "Sun is not up" in f:
        return 0
    if "at landing" in f:
        return 1
    if "battery" in f or "blackout" in f:
        return 2
    if "out of view" in f:
        return 3
    return 5


def summary_of(r: dict, cap_wh: float) -> dict:
    """JSON-friendly result (no arrays)."""
    return {"ok": r["ok"], "fails": r["fails"], "min_soc": r["minSoc"], "min_soc_at_h": r["kMin"],
            "below_reserve_at_h": r["kFail"] if r["kFail"] >= 0 else None, "longest_link_gap_h": r["maxGapH"],
            "longest_dark_h": r["maxDarkH"], "link_pct": r["linkPct"], "lit_pct": r["litPct"],
            "battery_needed_wh": r["battNeedWh"] if math.isfinite(r["battNeedWh"]) else None,
            "hours_simulated": r["n"], "safe_mode_hours": r["safeH"], "fault_starts_at_h": r["faultK"] if r["faultK"] >= 0 else None}
