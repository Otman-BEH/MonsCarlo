"""Design lab: work back from the mission to the hardware. Port of main's src/analysis.js (bisectUp, minArray,
designFrontier) and the design-lab and atlas logic in src/app.js (drawLab, drawAtlas).

Every bisection runs for many candidates at once: one vectorised mission simulation per bisection step for all battery
sizes (and, for the atlas, all landing times), with exactly main's step sequence, so results match main's.
"""
from __future__ import annotations

import math

import numpy as np

from . import mission as M
from .montecarlo import mission_batch

C0, C1 = 60.0, 60000.0


SCALAR_MAX = 16      # below this many candidates the scalar port is faster than one vectorised step loop


def _ok(se, i0, cfg, margin, peak, cap, shape, lsun=None) -> np.ndarray:
    T = len(peak)
    i0 = np.broadcast_to(np.asarray(i0, dtype=np.int64), (T,))
    ls = np.full(T, float(cfg["loadSun"])) if lsun is None else np.asarray(lsun, dtype=np.float64)
    if T <= SCALAR_MAX:
        # mission.mission is the scalar port of main's Ana.mission (same answers as mission_batch, tested), about
        # 0.3 ms per candidate against about 7 ms for one vectorised pass however few candidates it carries
        return np.array([M.mission(se, int(i0[k]), dict(cfg, peakW=float(peak[k]), capWh=float(cap[k]), loadSun=float(ls[k])),
                                   float(margin), False, shape)["ok"] for k in range(T)], dtype=bool)
    ok, _ = mission_batch(se, i0.copy(), cfg, np.full(T, float(margin)), np.asarray(peak, dtype=np.float64), ls,
                          np.full(T, float(cfg["loadDark"])), np.asarray(cap, dtype=np.float64), shape)
    return ok


def bisect_up(ok, lo, hi, iters: int) -> np.ndarray:
    """Vectorised bisectUp: smallest value in [lo, hi] for which ok holds; NaN where ok(hi) fails."""
    lo = np.asarray(lo, dtype=np.float64).copy()
    hi = np.asarray(hi, dtype=np.float64).copy()
    ok_hi = ok(hi)
    ok_lo = ok(lo)
    for _ in range(iters):
        m = (lo + hi) / 2
        o = ok(m)
        hi = np.where(o, m, hi)
        lo = np.where(o, lo, m)
    return np.where(~ok_hi, np.nan, np.where(ok_lo, lo, hi))


def min_array(se, i0, cfg, caps, robust: bool, p_max: float, iters: int, shape) -> np.ndarray:
    """Smallest array (W) that passes with each battery size; NaN where none does."""
    caps = np.asarray(caps, dtype=np.float64)
    margin = cfg["margin"] if robust else 0.0
    return bisect_up(lambda p: _ok(se, i0, cfg, margin, p, caps, shape), np.zeros(len(caps)), np.full(len(caps), p_max), iters)


def caps_grid(n: int) -> np.ndarray:
    return np.array([C0 * math.pow(C1 / C0, k / (n - 1)) for k in range(n)])


def _refine(se, i0s, cfg, caps, rob, mass_of, p_max, iters, shape):
    """main's 7-step ternary search for the lightest pair, for many frontiers at once (rows of rob)."""
    wkg, whkg = mass_of
    mass = lambda p, c: p / wkg + c / whkg
    J, n = rob.shape
    best = [None] * J
    bk = np.full(J, -1)
    for j in range(J):
        for k in range(n):
            if not np.isnan(rob[j, k]):
                m = mass(rob[j, k], caps[k])
                if best[j] is None or m < best[j][2]:
                    best[j] = [rob[j, k], caps[k], m]
                    bk[j] = k
    live = np.array([b is not None for b in best])
    if live.any():
        js = np.nonzero(live)[0]
        a = np.array([caps[max(0, bk[j] - 1)] for j in js])
        b = np.array([caps[min(n - 1, bk[j] + 1)] for j in js])
        i0j = np.asarray(i0s)[js]
        for _ in range(7):
            m1 = a + (b - a) / 3
            m2 = b - (b - a) / 3
            pr = min_array(se, np.concatenate([i0j, i0j]), cfg, np.concatenate([m1, m2]), True, p_max, iters, shape)
            p1, p2 = pr[: len(js)], pr[len(js):]
            for q, j in enumerate(js):
                f1 = 1e9 if np.isnan(p1[q]) else mass(p1[q], m1[q])
                f2 = 1e9 if np.isnan(p2[q]) else mass(p2[q], m2[q])
                if f1 < best[j][2]:
                    best[j] = [p1[q], m1[q], f1]
                if f2 < best[j][2]:
                    best[j] = [p2[q], m2[q], f2]
                if f1 < f2:
                    b[q] = m2[q]
                else:
                    a[q] = m1[q]
        for j in js:
            p = math.ceil(best[j][0] / 5) * 5
            c = math.ceil(best[j][1] / 10) * 10
            best[j] = {"peakW": float(p), "capWh": float(c), "mass": mass(p, c)}
    return [b if isinstance(b, dict) else None for b in best]


def frontier(se, i0: int, cfg: dict, mass_of=(80.0, 160.0), n_cap: int = 36, iters: int = 12, both: bool = True, shape=None) -> dict:
    """main's designFrontier: smallest passing array for a range of battery sizes, and the lightest pair."""
    shape = M.power_shape(se, cfg) if shape is None else shape
    p_max = max(3000.0, 12 * cfg["loadSun"])
    caps = caps_grid(n_cap)
    T = len(caps)
    rob = min_array(se, np.full(T, i0), cfg, caps, True, p_max, iters, shape)
    nom = min_array(se, np.full(T, i0), cfg, caps, False, p_max, iters, shape) if both else np.full(T, np.nan)
    best = _refine(se, np.array([i0]), cfg, caps, rob[None, :], mass_of, p_max, iters, shape)[0]
    nn = lambda a: [None if np.isnan(v) else float(v) for v in a]
    return {"caps": caps.tolist(), "rob": nn(rob), "nom": nn(nom) if both else [None] * T, "best": best, "pMax": p_max}


def atlas(se, i_first: int, cfg: dict, mass_of=(80.0, 160.0), n: int = 120, step_h: int = 12, shape=None) -> list:
    """main's drawAtlas: the lightest design for landings every step_h hours. None where nothing passes or the mission
    would run past the series."""
    shape = M.power_shape(se, cfg) if shape is None else shape
    p_max = max(3000.0, 12 * cfg["loadSun"])
    caps = caps_grid(12)
    need = cfg["days"] * 24
    idx = [i_first + j * step_h for j in range(n)]
    valid = [j for j, i in enumerate(idx) if not (i + need > se["n"])]
    out = [None] * n
    if not valid:
        return out
    J = len(valid)
    i0s = np.repeat([idx[j] for j in valid], len(caps))
    rob = min_array(se, i0s, cfg, np.tile(caps, J), True, p_max, 9, shape).reshape(J, len(caps))
    best = _refine(se, np.array([idx[j] for j in valid]), cfg, caps, rob, mass_of, p_max, 9, shape)
    for q, j in enumerate(valid):
        out[j] = best[q]
    return out


def lab(se, i0: int, cfg: dict, mass_of=(80.0, 160.0)) -> dict:
    """Everything the design-lab panel shows."""
    shape = M.power_shape(se, cfg)
    F = frontier(se, i0, cfg, mass_of, 36, 12, True, shape)
    b = F["best"]
    out = {"frontier": F, "mass_of": {"array_w_per_kg": mass_of[0], "battery_wh_per_kg": mass_of[1]}}
    if b:
        pa = min_array(se, np.array([i0]), cfg, np.array([cfg["capWh"]]), True, F["pMax"], 14, shape)[0]
        cb = bisect_up(lambda c: _ok(se, i0, cfg, cfg["margin"], np.full(len(c), cfg["peakW"]), c, shape), np.array([10.0]), np.array([60000.0]), 16)[0]
        v = M.verdict(se, i0, cfg, shape)
        load = None
        if v["state"] < 2:
            x = bisect_up(lambda vv: _ok(se, i0, cfg, cfg["margin"], np.full(len(vv), cfg["peakW"]), np.full(len(vv), cfg["capWh"]), shape, lsun=-vv),
                          np.array([-float(cfg["loadSun"])]), np.array([0.0]), 14)[0]
            load = None if np.isnan(x) else float(-x)
        trace = M.mission(se, i0, dict(cfg, peakW=b["peakW"], capWh=b["capWh"]), 0, True, shape)
        out.update({"min_array_at_your_battery_w": None if np.isnan(pa) else float(pa),
                    "min_battery_at_your_array_wh": None if np.isnan(cb) else float(cb),
                    "max_sunlit_load_w": load, "best_trace_soc": np.round(trace["soc"], 5).tolist()})
    else:
        r = M.mission(se, i0, dict(cfg, peakW=F["pMax"], capWh=60000.0), cfg["margin"], False, shape)
        out["why_none"] = r["fails"][0] if r["fails"] else "the needs cannot be met"
    return out


# ---------------------------------------------------------------- text and helpers for /mission-design
def fmt_w(p: float) -> str:
    return f"{M.js_round(p):,} W"


def fmt_cap(c: float) -> str:
    return f"{M.js_round(c):,} Wh"


def fmt_kg(m: float) -> str:
    return (M.js_fixed(m, 1) if m < 10 else str(M.js_round(m))) + " kg"


def fixes(cfg: dict, pa, cb, load, state: int, mass_of) -> list[dict]:
    """The fixes list of main's design lab, as numbers and as main's sentences (drawLab, src/app.js)."""
    wkg, whkg = mass_of
    out = []
    cap, peak = cfg["capWh"], cfg["peakW"]
    if pa is None:
        out.append({"kind": "array_at_your_battery", "keep": "battery", "array_w": None, "delta_kg": None,
                    "text": f"Keeping the {fmt_cap(cap)} battery: no array size is enough."})
    else:
        up = pa > peak
        r = math.ceil(pa / 5) * 5
        out.append({"kind": "array_at_your_battery", "keep": "battery", "array_w": float(r), "array_w_exact": float(pa),
                    "delta_kg": (pa - peak) / wkg,
                    "text": f"Keeping the {fmt_cap(cap)} battery: the array {'must grow to ' if up else 'could shrink to '}{fmt_w(r)} "
                            f"({'+' if up else '−'}{fmt_kg(abs(pa - peak) / wkg)})."})
    if cb is None:
        out.append({"kind": "battery_at_your_array", "keep": "array", "battery_wh": None, "delta_kg": None,
                    "text": f"Keeping the {fmt_w(peak)} array: no battery size is enough."})
    else:
        up = cb > cap
        r = math.ceil(cb / 10) * 10
        out.append({"kind": "battery_at_your_array", "keep": "array", "battery_wh": float(r), "battery_wh_exact": float(cb),
                    "delta_kg": (cb - cap) / whkg,
                    "text": f"Keeping the {fmt_w(peak)} array: the battery {'must grow to ' if up else 'could shrink to '}{fmt_cap(r)} "
                            f"({'+' if up else '−'}{fmt_kg(abs(cb - cap) / whkg)})."})
    if state < 2:
        if load is None or load < 1:
            out.append({"kind": "sunlit_load", "keep": "hardware", "load_sunlit_w": None,
                        "text": "Cutting the sunlight load alone cannot save this hardware."})
        else:
            out.append({"kind": "sunlit_load", "keep": "hardware", "load_sunlit_w": float(math.floor(load)), "load_sunlit_w_exact": float(load),
                        "text": f"Keeping all hardware: cut the sunlight load from {fmt_w(cfg['loadSun'])} to {fmt_w(math.floor(load))}."})
    return out


def best_dates(mass: list, n: int = 4, min_sep: int = 6) -> list[int]:
    """main's atlas table: the n lightest landing times, each at least min_sep steps from the ones already picked."""
    order = sorted((j for j, m in enumerate(mass) if m is not None), key=lambda j: mass[j])
    top: list[int] = []
    for j in order:
        if all(abs(q - j) >= min_sep for q in top):
            top.append(j)
        if len(top) == n:
            break
    return top
