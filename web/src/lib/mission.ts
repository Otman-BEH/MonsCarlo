// Hourly mission model: battery, sunlight and Earth link from a landing sample.
//
// Ported from fracAt / mission / verdict in src/analysis.js of MonsCarlo-Best
// (MIT), including the single-fault stress test and safe mode. Two additions,
// both inactive on the inputs his code accepts:
//   - the solar disc uses the series' own apparent radius when it has one
//     (his code always uses 0.266 degrees);
//   - the terrain margin may be a function of azimuth instead of one number.

import type { Series } from "./series";

export type FaultKind = "none" | "array" | "battery" | "load" | "antenna";

export interface MissionConfig {
  /** Mission length, days. */
  days: number;
  /** Array output in full sun at 1 AU, W. */
  peakW: number;
  /** Load while the Sun is up, W. */
  loadSun: number;
  /** Load in darkness, W. */
  loadDark: number;
  /** Battery capacity, Wh. */
  capWh: number;
  /** Reserve as a fraction of capacity, 0 to 1. */
  minSoc: number;
  /** true: Sun-tracking array. false: fixed horizontal panel, output times sin(elevation). */
  tracking: boolean;
  /** true: direct-to-Earth link required. */
  needEarth: boolean;
  /** Longest allowed Earth outage, hours. */
  maxGapH: number;
  /** Terrain margin for the robust verdict, degrees. */
  margin: number;
  chargeEff: number;
  /** Stress test: one fault from a chosen mission day. */
  fault?: { kind: FaultKind; day: number };
  /** Safe mode: shed to the dark load below 40 % charge, resume above 70 %. */
  safe?: boolean;
}

/** Terrain margin in degrees: raises the horizon for both Sun and Earth. A function receives the body's azimuth. */
export type Margin = number | ((azimuthDeg: number) => number);

export interface MissionResult {
  ok: boolean;
  /** Reasons for failure, in his wording and order. */
  fails: string[];
  minSoc: number;
  /** Hour of minimum charge, counted from landing. */
  kMin: number;
  /** Hour the reserve was first breached, or -1. */
  kFail: number;
  maxGapH: number;
  maxDarkH: number;
  linkPct: number;
  litPct: number;
  /** Battery that would have been enough, Wh. */
  battNeedWh: number;
  /** Hours simulated. */
  n: number;
  soc: Float32Array | null;
  sun: Float32Array | null;
  link: Uint8Array | null;
  safeH: number;
  safeArr: Uint8Array | null;
  /** Hour the fault starts, or -1. */
  faultK: number;
}

const SUNR = 0.266;

/** Visible fraction of the solar disc at sample i with the horizon raised by margin degrees. */
export function fracAt(se: Series, i: number, margin: number): number {
  const d = (se.sunClr[i] - margin) / (se.sunRad ? se.sunRad[i] : SUNR);
  return d >= 1 ? 1 : d <= -1 ? 0 : 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}

/** Mission simulation from sample i0 (1 h steps). keep = true also returns the hourly traces. */
export function mission(se: Series, i0: number, cfg: MissionConfig, margin: Margin, keep: boolean): MissionResult {
  const want = Math.round(cfg.days * 24), n = Math.max(0, Math.min(want, se.n - i0));
  const cap = cfg.capWh, floor = cfg.minSoc * cap;
  const mf = typeof margin === "function" ? margin : null, m0 = mf ? 0 : (margin as number);
  if (mf && !(se.sunAz && se.earthAz)) throw new Error("an azimuth-dependent margin needs sunAz and earthAz in the series");
  const mS = (i: number) => (mf ? mf(se.sunAz![i]) : m0), mE = (i: number) => (mf ? mf(se.earthAz![i]) : m0);
  let E = cap, minE = cap, kMin = 0, gap = 0, maxGap = 0, dark = 0, maxDark = 0, linkH = 0, litH = 0, draw = 0, maxDraw = 0, kFail = -1;
  // stress test: one fault from a chosen mission day, and an optional safe mode that sheds load when the battery runs low
  const F = cfg.fault && cfg.fault.kind !== "none" ? cfg.fault : null, fk = F ? Math.round(F.day * 24) : 1e9;
  let capNow = cap, safe = false, safeH = 0;
  const soc = keep ? new Float32Array(n + 1) : null, sun = keep ? new Float32Array(n) : null, link = keep ? new Uint8Array(n) : null, safeArr = keep ? new Uint8Array(n) : null;
  if (soc) soc[0] = 1;
  for (let k = 0; k < n; k++) {
    const i = i0 + k, f = fracAt(se, i, mS(i));
    const on = k >= fk;
    const p = cfg.peakW * se.irr[i] * f * (cfg.tracking ? 1 : Math.max(0, Math.sin(se.sunEl[i] * Math.PI / 180))) * (on && F!.kind === "array" ? 0.7 : 1);
    if (on && F!.kind === "battery" && capNow === cap) { capNow = cap * 0.75; if (E > capNow) E = capNow; }
    let load = f > 0.02 ? cfg.loadSun : cfg.loadDark;
    if (cfg.safe) { if (!safe && E < 0.4 * capNow) safe = true; else if (safe && E > 0.7 * capNow) safe = false; if (safe) { load = Math.min(load, cfg.loadDark); safeH++; } }
    if (on && F!.kind === "load") load += 100;
    const net = p - load, dE = net > 0 ? net * cfg.chargeEff : net;
    E = Math.min(capNow, E + dE); if (E < minE) { minE = E; kMin = k + 1; } if (E < floor && kFail < 0) kFail = k + 1;
    draw = Math.min(0, draw + dE); if (-draw > maxDraw) maxDraw = -draw;
    const L = se.earthClr[i] - mE(i) > 0 && !(on && F!.kind === "antenna" && k < fk + 24);
    if (L) { linkH++; gap = 0; } else { gap++; if (gap > maxGap) maxGap = gap; }
    if (f > 0.5) { litH++; dark = 0; } else { dark++; if (dark > maxDark) maxDark = dark; }
    if (keep) { soc![k + 1] = Math.max(0, E / cap); sun![k] = f; link![k] = L ? 1 : 0; safeArr![k] = safe ? 1 : 0; }
  }
  const fails: string[] = [];
  if (n < want) fails.push("the ephemeris window ends before the mission does");
  if (n > 0 && fracAt(se, i0, mS(i0)) <= 0.5) fails.push("the Sun is not up at landing");
  if (cfg.needEarth && n > 0 && !(se.earthClr[i0] - mE(i0) > 0)) fails.push("no Earth line of sight at landing");
  if (minE < floor) fails.push("battery falls to " + Math.max(0, Math.round(100 * minE / cap)) + "% on day " + (kMin / 24).toFixed(1));
  if (cfg.needEarth && maxGap > cfg.maxGapH) fails.push("Earth is out of view for " + (maxGap >= 48 ? (maxGap / 24).toFixed(1) + " d" : maxGap + " h") + " (limit " + cfg.maxGapH + " h)");
  return {
    ok: fails.length === 0, fails, minSoc: Math.max(0, minE / cap), kMin, kFail, maxGapH: maxGap, maxDarkH: maxDark,
    linkPct: n ? 100 * linkH / n : 0, litPct: n ? 100 * litH / n : 0, battNeedWh: maxDraw / (1 - cfg.minSoc), n, soc, sun, link, safeH, safeArr, faultK: F ? fk : -1,
  };
}

export interface Verdict {
  /** 2 = passes with the terrain margin, 1 = passes only without it, 0 = fails. */
  state: 0 | 1 | 2;
  nom: MissionResult;
  rob: MissionResult | null;
}

export function verdict(se: Series, i0: number, cfg: MissionConfig): Verdict {
  const nom = mission(se, i0, cfg, 0, false);
  if (!nom.ok) return { state: 0, nom, rob: null };
  const rob = mission(se, i0, cfg, cfg.margin, false);
  return { state: rob.ok ? 2 : 1, nom, rob };
}
