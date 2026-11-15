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

from . import dsn as DSN
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
                  ldark: np.ndarray, cap: np.ndarray, shape: np.ndarray, row: np.ndarray | None = None,
                  shape_per_trial: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised Ana.mission for T trials. Returns (ok (T,), first-fail cause index (T,), -1 when ok).

    One series: se arrays (H,), shape (H,) or (T, H) per trial.
    Many cells at once: se arrays (C, H), row (T,) = each trial's cell, shape (C, H) or (T, H) per trial."""
    T = len(i0)
    if row is None:
        g = lambda a, i: a[i]
    else:
        g = lambda a, i: a[row, i]
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
    per_trial_shape = (shape.ndim == 2) if row is None else shape_per_trial
    rows = np.arange(T)
    if row is not None and shape.ndim == 2 and not per_trial_shape:
        gs = lambda i: shape[row, i]
    elif per_trial_shape:
        gs = lambda i: shape[rows, i]
    else:
        gs = lambda i: shape[i]
    with np.errstate(invalid="ignore", divide="ignore"):
        for k in range(int(n.max(initial=0))):
            act = k < n
            i = np.minimum(i0 + k, nser - 1)
            d = (g(sunClr, i) - margin) / (g(sunRad, i) if sunRad is not None else M.SUNR)
            dc = np.clip(d, -1, 1)
            f = np.where(d >= 1, 1.0, np.where(d <= -1, 0.0, 1 - (np.arccos(dc) - dc * np.sqrt(1 - dc * dc)) / math.pi))
            on = k >= fk
            p = peak * g(irr, i) * f * gs(i) * (0.7 if (on and fkind == "array") else 1)
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
            L = (g(eclr, i) - margin > 0) & (not (on and fkind == "antenna" and k < fk + 24))
            gap = np.where(act, np.where(L, 0, gap + 1), gap)
            maxGap = np.maximum(maxGap, gap)
        # failure checks in main's order; cause of the first one
        cause = np.full(T, -1)

        def first(mask, c):
            nonlocal cause
            cause = np.where((cause < 0) & mask, c, cause)
        first(n < want, 5)
        i0c = np.minimum(i0, nser - 1)
        d0 = (g(sunClr, i0c) - margin) / (g(sunRad, i0c) if sunRad is not None else M.SUNR)
        dc0 = np.clip(d0, -1, 1)
        f0 = np.where(d0 >= 1, 1.0, np.where(d0 <= -1, 0.0, 1 - (np.arccos(dc0) - dc0 * np.sqrt(1 - dc0 * dc0)) / math.pi))
        first((n > 0) & (f0 <= 0.5), 0)
        if cfg["needEarth"]:
            first((n > 0) & ~(g(eclr, i0c) - margin > 0), 1)
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


def _trial_params(d: dict, sig: dict, cfg: dict, i0: int, n_ser: int) -> dict:
    """Turn the raw normal draws into trial inputs exactly as main's cellTrials does."""
    l = np.maximum(0.0, 1 + sig["load"] * d["z"])
    zc = d["zc"]                       # draws() already set zc = -z when the cold-case link is on
    lo_i = n_ser - M.js_round(cfg["days"] * 24)
    return {"peak": cfg["peakW"] * np.maximum(0.0, 1 + sig["power"] * d["zp"]), "lsun": cfg["loadSun"] * l, "ldark": cfg["loadDark"] * l,
            "cap": cfg["capWh"] * np.maximum(0.1, 1 + sig["cap"] * zc),
            "i": np.maximum(0, np.minimum(lo_i, i0 + np.floor(sig["timeH"] * d["zt"] + 0.5).astype(np.int64))),
            "margin": sig["terrainDeg"] * d["zm"]}


def run_risk(terrain: Terrain, table: np.ndarray, i0: int, lat: float, lon: float, lander: dict, cfg: dict,
             unc: Uncertainty, mode: str = "best", naz: int = 180, workers: int = 8, dsn_ok: np.ndarray | None = None) -> dict:
    """Port of main's runRisk. table: hourly (n, 6) window; i0: landing index in it.

    Every cell's horizon is cast (in parallel threads), then all trials of all cells run as one vectorised simulation.
    Each cell keeps main's two random streams mix(seed, k, 0) and mix(seed, k, 1), so draws are identical to main's."""
    from concurrent.futures import ThreadPoolExecutor
    n = unc.grid_n
    K = unc.trials_per_cell + (unc.trials_per_cell % 2)
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
    ah, eh = float(arr["height_m"]), float(lander["comms"]["antenna_height_m"])
    heading_random = unc.heading_random and arr["type"] == "vertical"
    x0, y0 = (float(v) for v in ll_to_xy(max(-89.999, lat), lon))
    c = (n - 1) / 2
    ci = int(c)
    ix, iy = np.meshgrid(np.arange(n), np.arange(n))
    X = x0 + (ix - c) * sp
    Y = y0 + (c - iy) * sp
    LAT, LON = xy_to_ll(X, Y)
    LAT = np.maximum(-89.999, LAT)
    slope = terrain.slope_xy(X.ravel(), Y.ravel(), mode)
    cells = [k for k in range(n * n) if not slope[k] > max_slope]
    heights = sorted({ah, eh})

    def cast(k):
        hm = terrain.horizon(float(LAT.flat[k]), float(LON.flat[k]), heights, naz, mode, use_cache=False, fast=True)
        v = V.View(lat=float(LAT.flat[k]), lon=float(LON.flat[k]), ground_m=hm.ground_m, sun_mask=hm.at_height(ah),
                   earth_mask=hm.at_height(eh), array_h=ah, antenna_h=eh)
        return DSN.apply(V.series(v, table), dsn_ok)
    with ThreadPoolExecutor(max(1, workers)) as ex:
        sers = list(ex.map(cast, cells))
    C = len(cells)
    det = np.zeros(n * n, np.int8)
    PA = np.zeros(n * n); PB = np.zeros(n * n)
    cause = np.zeros((n * n, 6))
    cause[[k for k in range(n * n) if slope[k] > max_slope], 4] = K          # too steep: every trial fails there
    if C:
        stack = {key: np.stack([s[key] for s in sers]) for key in ("sunClr", "sunRad", "irr", "earthClr", "sunEl", "sunAz")}
        stack["n"] = table.shape[0]
        shapes = np.stack([M.power_shape(s, cfg) for s in sers])
        for j, k in enumerate(cells):
            det[k] = M.verdict(sers[j], i0, cfg, shapes[j])["state"]
        # draws: cell j, half h -> trials [ (2j + h) * half, (2j + h + 1) * half )
        D = {key: np.empty(2 * C * half) for key in ("z", "zc", "zp", "zt", "zm")}
        hd = np.empty(2 * C * half) if heading_random else None
        for j, k in enumerate(cells):
            for h in (0, 1):
                d = draws(Rng(mix(seed, k, h)), half, sig)      # same order as main, including the skipped draw when linked
                sl = slice((2 * j + h) * half, (2 * j + h + 1) * half)
                for key in D:
                    D[key][sl] = d[key]
                if heading_random:
                    hR = Rng(mix(seed, k, 7 + h))
                    hd[sl] = [hR.u() * 360.0 for _ in range(half)]
        row = np.repeat(np.arange(C), 2 * half)
        is_b = np.tile(np.repeat([False, True], half), C)
        if heading_random:
            tshape = PW.shape(arr, stack["sunEl"][row], stack["sunAz"][row], hd[:, None])
        else:
            tshape = shapes

        def simulate(s: dict, mask: np.ndarray | None = None):
            p = _trial_params(D, s, cfg, i0, stack["n"])
            sel = slice(None) if mask is None else mask
            ok, cz = mission_batch(stack, p["i"][sel], cfg, p["margin"][sel], p["peak"][sel], p["lsun"][sel], p["ldark"][sel],
                                   p["cap"][sel], tshape[sel] if heading_random else tshape, row=row[sel], shape_per_trial=heading_random)
            return ok, cz
        ok, cz = simulate(sig)
        okf = ok.astype(np.float64)
        for j, k in enumerate(cells):
            a = slice(2 * j * half, (2 * j + 1) * half)
            b = slice((2 * j + 1) * half, (2 * j + 2) * half)
            PA[k], PB[k] = okf[a].mean(), okf[b].mean()
            cause[k] += np.bincount(cz[2 * j * half:(2 * j + 2) * half][cz[2 * j * half:(2 * j + 2) * half] >= 0], minlength=6)[:6]
    P = (PA + PB) / 2
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
    # drivers: the same draws with one source of error switched off (common random numbers), over the cells inside 3 sigma
    pos = {k: j for j, k in enumerate(cells)}
    inner = [(pos[k], w) for k, w in wts if k in pos]

    def without(z: dict) -> float:
        if not inner:
            return 0.0
        mask = np.isin(row, [j for j, _ in inner]) if C else None
        ok2, _ = simulate(dict(sig, **z), mask)
        rr = row[mask]
        okf2 = ok2.astype(np.float64)
        per = np.bincount(rr, weights=okf2, minlength=C) / np.maximum(1, np.bincount(rr, minlength=C))
        return sum(w * per[j] for j, w in inner) / sw
    centre = ci * n + ci
    drivers = [("An exact touchdown", float(P[centre])), ("An exact landing time", without({"timeH": 0})),
               ("Perfect terrain data", without({"terrainDeg": 0})), ("Hardware exactly as specified", without({"power": 0, "load": 0, "cap": 0}))]
    steep = sum(w for k, w in wts if slope[k] > max_slope) / sw
    return {
        "success_p": cur["p"], "ci95": [cur["lo"], cur["hi"]],
        "deterministic_verdict_at_aim": M.VERDICTS[0 if slope[centre] > max_slope else int(det[centre])],
        "slope_at_aim_deg": float(slope[centre]),
        "causes": {M.CAUSE_KEYS[j]: float(cw[j] / sw) for j in range(6)},
        "drivers": [{"if": name, "success_p": float(p), "gain_points": float(100 * (p - cur["p"]))} for name, p in drivers],
        "best_aim": best, "steep_share": float(steep),
        "grid": {"n": n, "spacing_m": sp, "half_width_m": W, "lat": LAT.ravel().tolist(), "lon": LON.ravel().tolist(),
                 "success": P.tolist(), "slope_deg": slope.tolist(), "deterministic": det.tolist()},
        "total_missions": n * n * K, "seed": seed, "trials_per_cell": K,
        "settings": {"accuracy_m_3sigma": acc, "max_slope_deg": max_slope, **unc.model_dump()},
    }
