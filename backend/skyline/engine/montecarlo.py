"""Monte Carlo landing risk. Port of main's src/analysis.js (rng, mix, cellTrials, aimProb, aimStats, wilson) and
src/app.js runRisk (grid, slope, drivers, best aim point), with the trials inside a cell simulated together (NumPy arrays
of shape (trials,) stepped hour by hour).

The random numbers are a bit-exact port of main's generator, drawn in the same order, so the same seed gives the same
draws as the browser.
"""
from __future__ import annotations

import math
import struct
from typing import Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from . import mission as M
from . import power as PW
from . import visibility as V
from .terrain import R2D, D2R, Terrain, ll_to_xy, xy_to_ll

U32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & U32


# fdlibm __ieee754_log, as used by V8's Math.log, so the normal draws match the browser bit for bit
# (the C library log can differ in the last bit).
_LN2_HI, _LN2_LO, _TWO54 = 6.93147180369123816490e-01, 1.90821492927058770002e-10, 1.80143985094819840000e+16
_LG = (6.666666666666735130e-01, 3.999999999940941908e-01, 2.857142874366239149e-01, 2.222219843214978396e-01,
       1.818357216161805012e-01, 1.531383769920937332e-01, 1.479819860511658591e-01)


def _words(x: float) -> tuple[int, int]:
    b = struct.unpack("<Q", struct.pack("<d", x))[0]
    hi = b >> 32
    return (hi - (1 << 32) if hi & 0x80000000 else hi), b & U32


def _from_words(hi: int, lo: int) -> float:
    return struct.unpack("<d", struct.pack("<Q", ((hi & U32) << 32) | (lo & U32)))[0]


def js_log(x: float, fma: bool = False) -> float:
    """fdlibm log as compiled into V8. fma=True reproduces builds where the compiler fuses multiply-adds (Node and
    Chrome on Apple Silicon, checked bit for bit on 20,000 inputs); fma=False is the plain fdlibm arithmetic (x64)."""
    F = math.fma if fma else (lambda a, b, c: a * b + c)
    hx, lx = _words(x)
    k = 0
    if hx < 0x00100000:
        if ((hx & 0x7FFFFFFF) | lx) == 0:
            return -math.inf
        if hx < 0:
            return math.nan
        k -= 54
        x *= _TWO54
        hx, lx = _words(x)
    if hx >= 0x7FF00000:
        return x + x
    k += (hx >> 20) - 1023
    hx &= 0x000FFFFF
    i = (hx + 0x95F64) & 0x100000
    x = _from_words(hx | (i ^ 0x3FF00000), _words(x)[1])
    k += i >> 20
    f = x - 1.0
    dk = float(k)
    if (0x000FFFFF & (2 + hx)) < 3:
        if f == 0.0:
            return 0.0 if k == 0 else F(dk, _LN2_HI, dk * _LN2_LO)
        R = f * f * F(-0.33333333333333333, f, 0.5)
        return f - R if k == 0 else dk * _LN2_HI - (F(-dk, _LN2_LO, R) - f)
    s = f / (2.0 + f)
    z = s * s
    i = hx - 0x6147A
    w = z * z
    j = 0x6B851 - hx
    t1 = w * F(w, F(w, _LG[5], _LG[3]), _LG[1])
    t2 = z * F(w, F(w, F(w, _LG[6], _LG[4]), _LG[2]), _LG[0])
    i |= j
    R = t2 + t1
    if i > 0:
        hfsq = 0.5 * f * f
        if k == 0:
            return f - F(-s, hfsq + R, hfsq)
        return F(dk, _LN2_HI, -((hfsq - F(s, hfsq + R, dk * _LN2_LO)) - f))
    if k == 0:
        return F(-s, f - R, f)
    return F(dk, _LN2_HI, -(F(s, f - R, -dk * _LN2_LO) - f))


class Rng:
    """main's rng(seed): mulberry32-style uniform u() in [0, 1), Marsaglia polar normal n() with a spare."""
    __slots__ = ("a", "spare", "fma")
    FMA_DEFAULT = False

    def __init__(self, seed: int, fma: bool | None = None):
        self.a = seed & U32
        self.spare: float | None = None
        self.fma = Rng.FMA_DEFAULT if fma is None else fma

    def u(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & U32
        a = self.a
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & U32) ^ t
        return ((t ^ (t >> 14)) & U32) / 4294967296.0

    def n(self) -> float:
        if self.spare is not None:
            s, self.spare = self.spare, None
            return s
        while True:
            x = self.u() * 2 - 1
            y = self.u() * 2 - 1
            r = x * x + y * y
            if 0 < r < 1:
                break
        f = math.sqrt(-2 * js_log(r, self.fma) / r)
        self.spare = y * f
        return x * f


def mix(seed: int, k: int, salt: int) -> int:
    """main's mix: decorrelates a seed, a cell index and a stream id (murmur3 finaliser)."""
    h = ((seed & U32) ^ _imul((k + 1) & U32, 0x9E3779B1) ^ _imul((salt + 1) & U32, 0x85EBCA6B)) & U32
    h ^= h >> 16
    h = _imul(h, 0x85EBCA6B)
    h ^= h >> 13
    h = _imul(h, 0xC2B2AE35)
    h ^= h >> 16
    return h & U32


def wilson(p: float, n: float) -> tuple[float, float]:
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def _weights(n: int, s: float, ax: int, ay: int, sigma: float):
    r = max(1, math.ceil(3 * sigma / s))
    ys = np.arange(max(0, ay - r), min(n - 1, ay + r) + 1)
    xs = np.arange(max(0, ax - r), min(n - 1, ax + r) + 1)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    d2 = ((xx - ax) ** 2 + (yy - ay) ** 2) * s * s
    keep = d2 <= 9 * sigma * sigma + 1e-9
    w = np.exp(-d2 / (2 * sigma * sigma))
    return yy[keep], xx[keep], w[keep], r


def aim_prob(P: np.ndarray, n: int, s: float, ax: int, ay: int, sigma: float) -> dict:
    yy, xx, w, _ = _weights(n, s, ax, ay, sigma)
    sw, sw2 = w.sum(), (w * w).sum()
    sp = (w * P[yy * n + xx]).sum()
    return {"p": sp / sw if sw else 0.0, "nEff": sw * sw / sw2 if sw2 else 0.0}


def aim_stats(P: np.ndarray, n: int, s: float, ax: int, ay: int, sigma: float, K: int) -> dict:
    yy, xx, w, r = _weights(n, s, ax, ay, sigma)
    inside = ax - r >= 0 and ay - r >= 0 and ax + r <= n - 1 and ay + r <= n - 1
    q = P[yy * n + xx].astype(np.float64)
    sw, sw2 = float(w.sum()), float((w * w).sum())
    sp = float((w * q).sum())
    v = float((w * w * q * (1 - q) / K).sum())
    p = sp / sw if sw else 0.0
    vr = v / (sw * sw) if sw else 0.0
    nEff = p * (1 - p) / vr if (vr > 1e-9 and 0 < p < 1) else K * (sw * sw / sw2 if sw2 else 1)
    lo, hi = wilson(p, max(1.0, nEff))
    var = max(vr, p * (1 - p) / max(1.0, K * (sw * sw / sw2 if sw2 else 1)))
    return {"p": p, "var": var, "nEff": nEff, "lo": lo, "hi": hi, "inside": inside}


# ---------------------------------------------------------------- vectorised trials
def draws(R: Rng, K: int, sig: dict) -> dict:
    """The random numbers of K trials, in main's order: load (z), capacity (zc or -z), power, landing time, terrain."""
    z = np.empty(K); zc = np.empty(K); zp = np.empty(K); zt = np.empty(K); zm = np.empty(K)
    corr = bool(sig.get("corr"))
    for k in range(K):
        z[k] = R.n()
        zc[k] = -z[k] if corr else R.n()
        zp[k] = R.n()
        zt[k] = R.n()
        zm[k] = R.n()
    return {"z": z, "zc": zc, "zp": zp, "zt": zt, "zm": zm}


def mission_batch(se: dict, i0: np.ndarray, cfg: dict, margin: np.ndarray, peak: np.ndarray, lsun: np.ndarray,
                  ldark: np.ndarray, cap: np.ndarray, shape: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised Ana.mission for T trials. Returns (ok (T,), first-fail cause index (T,), -1 when ok).
    shape: (H,) shared or (T, H) per trial."""
    T = len(i0)
    nser = se["n"]
    want = M.js_round(cfg["days"] * 24)
    n = np.maximum(0, np.minimum(want, nser - i0))
    floor = cfg["minSoc"] * cap
    E = cap.astype(np.float64).copy()
    minE = E.copy()
    gap = np.zeros(T, np.int64); maxGap = np.zeros(T, np.int64)
    draw = np.zeros(T); maxDraw = np.zeros(T)
    F = cfg["fault"] if cfg.get("fault") and cfg["fault"]["kind"] != "none" else None
    fk = M.js_round(F["day"] * 24) if F else 10 ** 9
    fkind = F["kind"] if F else "none"
    capNow = cap.astype(np.float64).copy()
    safe = np.zeros(T, bool)
    eff = cfg["chargeEff"]
    sunClr, sunRad, irr, eclr = se["sunClr"], se.get("sunRad"), se["irr"], se["earthClr"]
    per_trial_shape = shape.ndim == 2
    rows = np.arange(T)
    with np.errstate(invalid="ignore", divide="ignore"):
        for k in range(int(n.max(initial=0))):
            act = k < n
            i = np.minimum(i0 + k, nser - 1)
            d = (sunClr[i] - margin) / (sunRad[i] if sunRad is not None else M.SUNR)
            dc = np.clip(d, -1, 1)
            f = np.where(d >= 1, 1.0, np.where(d <= -1, 0.0, 1 - (np.arccos(dc) - dc * np.sqrt(1 - dc * dc)) / math.pi))
            on = k >= fk
            shp = shape[rows, i] if per_trial_shape else shape[i]
            p = peak * irr[i] * f * shp * (0.7 if (on and fkind == "array") else 1)
            if on and fkind == "battery" and k == fk:
                capNow = np.where(act, cap * 0.75, capNow)
                E = np.where(act & (E > capNow), capNow, E)
            load = np.where(f > 0.02, lsun, ldark)
            if cfg["safe"]:
                enter = ~safe & (E < 0.4 * capNow)
                leave = safe & (E > 0.7 * capNow)
                safe = np.where(act, (safe | enter) & ~leave, safe)
                load = np.where(safe, np.minimum(load, ldark), load)
            if on and fkind == "load":
                load = load + 100
            net = p - load
            dE = np.where(net > 0, net * eff, net)
            En = np.minimum(capNow, E + dE)
            E = np.where(act, En, E)
            minE = np.where(act & (E < minE), E, minE)
            dn = np.minimum(0.0, draw + dE)
            draw = np.where(act, dn, draw)
            maxDraw = np.where(act & (-draw > maxDraw), -draw, maxDraw)
            L = (eclr[i] - margin > 0) & (not (on and fkind == "antenna" and k < fk + 24))
            gap = np.where(act, np.where(L, 0, gap + 1), gap)
            maxGap = np.maximum(maxGap, gap)
        # failure checks in main's order; cause of the first one
        cause = np.full(T, -1)

        def first(mask, c):
            nonlocal cause
            cause = np.where((cause < 0) & mask, c, cause)
        first(n < want, 5)
        i0c = np.minimum(i0, nser - 1)
        d0 = (sunClr[i0c] - margin) / (sunRad[i0c] if sunRad is not None else M.SUNR)
        dc0 = np.clip(d0, -1, 1)
        f0 = np.where(d0 >= 1, 1.0, np.where(d0 <= -1, 0.0, 1 - (np.arccos(dc0) - dc0 * np.sqrt(1 - dc0 * dc0)) / math.pi))
        first((n > 0) & (f0 <= 0.5), 0)
        if cfg["needEarth"]:
            first((n > 0) & ~(eclr[i0c] - margin > 0), 1)
        first(~np.isfinite(E) | ~np.isfinite(minE), 5)
        first(minE < floor, 2)
        autoWh = (cfg.get("autonomyH") or 0) * ldark
        first((autoWh > 0) & (minE >= floor) & (minE - floor < autoWh), 2)
        if cfg["needEarth"]:
            first(maxGap > cfg["maxGapH"], 3)
    return cause < 0, cause


def cell_trials(se: dict, i0: int, cfg: dict, sig: dict, R: Rng, K: int, counts: np.ndarray, shape: np.ndarray,
                heading_sigma: Optional[tuple] = None) -> float:
    """K random missions for one touchdown cell (main's cellTrials). Failure causes are added to counts (6,)."""
    d = draws(R, K, sig)
    l = np.maximum(0.0, 1 + sig["load"] * d["z"])
    peak = cfg["peakW"] * np.maximum(0.0, 1 + sig["power"] * d["zp"])
    cap = cfg["capWh"] * np.maximum(0.1, 1 + sig["cap"] * d["zc"])
    lo_i = se["n"] - M.js_round(cfg["days"] * 24)
    i = np.maximum(0, np.minimum(lo_i, i0 + np.floor(sig["timeH"] * d["zt"] + 0.5).astype(np.int64)))
    margin = sig["terrainDeg"] * d["zm"]
    shp = shape
    if heading_sigma is not None:     # random heading per trial (vertical panels): uniform, from its own stream
        arr, hR = heading_sigma
        hd = np.array([hR.u() * 360.0 for _ in range(K)])[:, None]
        shp = PW.shape(arr, se["sunEl"][None, :], se["sunAz"][None, :], hd)
    ok, cause = mission_batch(se, i, cfg, margin, peak, cfg["loadSun"] * l, cfg["loadDark"] * l, cap, shp)
    for c in cause[~ok]:
        counts[c] += 1
    return float(ok.sum()) / K


# ---------------------------------------------------------------- the full run
class Uncertainty(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time_3sigma_h: float = Field(default=6, ge=0, le=72)
    terrain_sigma_deg: float = Field(default=0.15, ge=0, le=2)
    power_sigma_pct: float = Field(default=5, ge=0, le=50)
    load_sigma_pct: float = Field(default=5, ge=0, le=50)
    capacity_sigma_pct: float = Field(default=3, ge=0, le=50)
    cold_case_link: bool = False
    heading_random: bool = False
    seed: int = Field(default=20261114, ge=1, le=2 ** 32 - 1)
    grid_n: int = Field(default=15, ge=5, le=31)
    trials_per_cell: int = Field(default=48, ge=2, le=1000)
    accuracy_m_3sigma: Optional[float] = Field(default=None, gt=0, le=20000)
    max_slope_deg: Optional[float] = Field(default=None, gt=0, le=60)


def window_hours(unc: Uncertainty, days: float) -> tuple[int, int]:
    """Hours of ephemeris needed before and after the landing time: J and J + mission length."""
    J = math.ceil(4 * unc.time_3sigma_h / 3) + 1
    return J, J + M.js_round(days * 24) + 1


def run_risk(terrain: Terrain, table: np.ndarray, i0: int, lat: float, lon: float, lander: dict, cfg: dict,
             unc: Uncertainty, mode: str = "best", naz: int = 180) -> dict:
    """Port of runRisk. table: hourly (n, 6) window; i0: landing index in it."""
    n = unc.grid_n
    K = unc.trials_per_cell
    if K % 2:
        K += 1
    half = K // 2
    acc = unc.accuracy_m_3sigma or lander["landing"]["accuracy_m_3sigma"]
    max_slope = unc.max_slope_deg or lander["landing"]["max_slope_deg"]
    Rm = acc
    W = 2.5 * Rm
    sp = 2 * W / (n - 1)
    sigma = Rm / 3
    sig = {"timeH": unc.time_3sigma_h / 3, "terrainDeg": unc.terrain_sigma_deg, "power": unc.power_sigma_pct / 100,
           "load": unc.load_sigma_pct / 100, "cap": unc.capacity_sigma_pct / 100, "corr": unc.cold_case_link}
    seed = unc.seed
    arr = lander["power"]["array"]
    ah, eh = arr["height_m"], lander["comms"]["antenna_height_m"]
    x0, y0 = (float(v) for v in ll_to_xy(max(-89.999, lat), lon))
    c = (n - 1) / 2
    ix, iy = np.meshgrid(np.arange(n), np.arange(n))
    X = x0 + (ix - c) * sp
    Y = y0 + (c - iy) * sp
    LAT, LON = xy_to_ll(X, Y)
    LAT = np.maximum(-89.999, LAT)
    slope = terrain.slope_xy(X.ravel(), Y.ravel(), mode).reshape(n, n)
    PA = np.zeros(n * n); PB = np.zeros(n * n); det = np.zeros(n * n, np.int8)
    cause = np.zeros((n * n, 6))
    sers: dict[int, tuple] = {}
    heights = sorted({float(ah), float(eh)})
    for k in range(n * n):
        yy, xx = divmod(k, n)
        if slope[yy, xx] > max_slope:
            cause[k, 4] = K
            continue
        hm = terrain.horizon(float(LAT[yy, xx]), float(LON[yy, xx]), heights, naz, mode, use_cache=False, fast=True)
        v = V.View(lat=float(LAT[yy, xx]), lon=float(LON[yy, xx]), ground_m=hm.ground_m, sun_mask=hm.at_height(ah),
                   earth_mask=hm.at_height(eh), array_h=ah, antenna_h=eh)
        se = V.series(v, table)
        shp = M.power_shape(se, cfg)
        hs = (arr, Rng(mix(seed, k, 7))) if (unc.heading_random and arr["type"] == "vertical") else None
        PA[k] = cell_trials(se, i0, cfg, sig, Rng(mix(seed, k, 0)), half, cause[k], shp, hs)
        hs = (arr, Rng(mix(seed, k, 8))) if (unc.heading_random and arr["type"] == "vertical") else None
        PB[k] = cell_trials(se, i0, cfg, sig, Rng(mix(seed, k, 1)), half, cause[k], shp, hs)
        det[k] = M.verdict(se, i0, cfg, shp)["state"]
        if math.hypot(xx - c, yy - c) * sp <= Rm + 1e-9:
            sers[k] = (se, shp)
    P = (PA + PB) / 2
    ci = int(c)
    cur = aim_stats(P, n, sp, ci, ci, sigma, K)
    wts = []
    cw = np.zeros(6)
    sw = 0.0
    for yy in range(n):
        for xx in range(n):
            d2 = ((xx - c) ** 2 + (yy - c) ** 2) * sp * sp
            if d2 > Rm * Rm + 1e-9:
                continue
            w = math.exp(-d2 / (2 * sigma * sigma))
            k = yy * n + xx
            wts.append((k, w))
            sw += w
            cw += w * cause[k] / K
    # best aim point: chosen on half A, judged on half B
    pick = {"p": aim_stats(PA, n, sp, ci, ci, sigma, half)["p"], "ix": ci, "iy": ci}
    for yy in range(n):
        for xx in range(n):
            if math.hypot(xx - c, yy - c) * sp > 1.5 * Rm + 1e-9:
                continue
            a = aim_stats(PA, n, sp, xx, yy, sigma, half)
            if a["inside"] and a["p"] > pick["p"] + 1e-9:
                pick = {"p": a["p"], "ix": xx, "iy": yy}
    vb = aim_stats(PB, n, sp, pick["ix"], pick["iy"], sigma, half)
    vc = aim_stats(PB, n, sp, ci, ci, sigma, half)
    diff = vb["p"] - vc["p"]
    se2 = math.sqrt(vb["var"] + vc["var"])
    dx = (pick["ix"] - c) * sp
    dy = (c - pick["iy"]) * sp
    so, co = math.sin(lon * D2R), math.cos(lon * D2R)
    best = {"p": vb["p"], "lo": vb["lo"], "hi": vb["hi"], "gain": diff,
            "clear": bool((pick["ix"] != ci or pick["iy"] != ci) and diff >= 0.03 and diff - 1.96 * se2 > 0),
            "distance_m": math.hypot(dx, dy), "bearing_deg": (math.atan2(dx * co - dy * so, dx * so + dy * co) * R2D + 360) % 360,
            "lat": float(LAT[pick["iy"], pick["ix"]]), "lon": float(LON[pick["iy"], pick["ix"]])}
    # drivers: the same draws with one source of error switched off (common random numbers)
    dump = np.zeros(6)

    def without(z: dict) -> float:
        s2 = dict(sig, **z)
        acc_p = 0.0
        for k, w in wts:
            if k not in sers:
                continue
            se, shp = sers[k]
            hA = (arr, Rng(mix(seed, k, 7))) if (unc.heading_random and arr["type"] == "vertical") else None
            hB = (arr, Rng(mix(seed, k, 8))) if (unc.heading_random and arr["type"] == "vertical") else None
            acc_p += w * (cell_trials(se, i0, cfg, s2, Rng(mix(seed, k, 0)), half, dump, shp, hA)
                          + cell_trials(se, i0, cfg, s2, Rng(mix(seed, k, 1)), half, dump, shp, hB)) / 2
        return acc_p / sw
    centre = ci * n + ci
    drivers = [("An exact touchdown", float(P[centre])), ("An exact landing time", without({"timeH": 0})),
               ("Perfect terrain data", without({"terrainDeg": 0})), ("Hardware exactly as specified", without({"power": 0, "load": 0, "cap": 0}))]
    steep = sum(w for k, w in wts if slope.ravel()[k] > max_slope) / sw
    return {
        "success_p": cur["p"], "ci95": [cur["lo"], cur["hi"]],
        "deterministic_verdict_at_aim": M.VERDICTS[0 if slope[ci, ci] > max_slope else int(det[centre])],
        "slope_at_aim_deg": float(slope[ci, ci]),
        "causes": {M.CAUSE_KEYS[j]: float(cw[j] / sw) for j in range(6)},
        "drivers": [{"if": name, "success_p": p, "gain_points": 100 * (p - cur["p"])} for name, p in drivers],
        "best_aim": best, "steep_share": steep,
        "grid": {"n": n, "spacing_m": sp, "half_width_m": W, "lat": LAT.ravel().tolist(), "lon": LON.ravel().tolist(),
                 "success": P.tolist(), "slope_deg": slope.ravel().tolist(), "deterministic": det.tolist()},
        "total_missions": n * n * K, "seed": seed, "trials_per_cell": K,
        "settings": {"accuracy_m_3sigma": acc, "max_slope_deg": max_slope, **unc.model_dump()},
    }
