// Monte Carlo building blocks for the landing-risk analysis.
//
// Ported from rng / cellTrials / aimProb / wilson / aimStats in
// src/analysis.js of MonsCarlo-Best (MIT). With terrainModel "shift" (the
// default here) cellTrials consumes random numbers in exactly his order, so
// the same seed gives the same outcome as his code; test/fixtures/
// montecarlo_golden.json holds values produced by his original file.

import { mission, type MissionConfig } from "./mission";
import type { Series } from "./series";

export interface Rng {
  /** Uniform in [0, 1). */
  u(): number;
  /** Standard normal. */
  n(): number;
}

/** Seeded random numbers (mulberry32, polar Box-Muller). The same seed gives the same run. */
export function rng(seed: number): Rng {
  let a = seed >>> 0, spare: number | null = null;
  const u = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { if (spare !== null) { const s = spare; spare = null; return s; } let x, y, r; do { x = u() * 2 - 1; y = u() * 2 - 1; r = x * x + y * y; } while (r >= 1 || r === 0); const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f; };
  return { u, n };
}

export const CAUSES = ["Dark at landing", "No Earth line of sight at landing", "Battery below reserve", "Link gap too long", "Ground too steep", "Other"] as const;
export const CAUSE_STEEP = 4;

export function causeOf(f: string): number {
  return /Sun is not up/.test(f) ? 0 : /at landing/.test(f) ? 1 : /battery/.test(f) ? 2 : /out of view/.test(f) ? 3 : 5;
}

/** 1-sigma spreads of the error sources. */
export interface Spreads {
  /** Landing time, hours. */
  timeH: number;
  /** Terrain horizon error, degrees. */
  terrainDeg: number;
  /** Array output, as a fraction (0.05 = 5 %). */
  power: number;
  loads: number;
  /** Battery capacity, as a fraction. */
  cap: number;
  /** true: high loads and low capacity share one draw. */
  linked?: boolean;
  /**
   * "shift" (his model): one horizon shift per trial for every azimuth.
   * "azimuth": the error varies smoothly around the horizon (a constant plus
   * the first two harmonics, same 1-sigma at every azimuth), so the Sun and
   * Earth, and the Sun at different times, see partly independent errors.
   */
  terrainModel?: "shift" | "azimuth";
}

const D2R = Math.PI / 180;

/**
 * K random missions for one touchdown cell. se is that cell's series; i0 the
 * nominal landing sample in it. Failure causes are added to counts[6].
 * Returns the success share.
 */
export function cellTrials(se: Series, i0: number, cfg: MissionConfig, sig: Spreads, R: Rng, K: number, counts: ArrayLike<number> & { [i: number]: number }): number {
  let ok = 0; const c = Object.assign({}, cfg);
  const az = sig.terrainModel === "azimuth", s3 = sig.terrainDeg / Math.sqrt(3);
  for (let k = 0; k < K; k++) {
    // sig.linked: one shared "cold case" draw raises the loads and lowers the battery capacity together
    const z = R.n(), l = Math.max(0, 1 + sig.loads * z), zc = sig.linked ? -z : R.n();
    c.peakW = cfg.peakW * Math.max(0, 1 + sig.power * R.n()); c.loadSun = cfg.loadSun * l; c.loadDark = cfg.loadDark * l; c.capWh = cfg.capWh * Math.max(0.1, 1 + sig.cap * zc);
    const i = Math.max(0, Math.min(se.n - Math.round(cfg.days * 24), i0 + Math.round(sig.timeH * R.n()))); // keep the whole mission inside the series
    let r;
    if (az) {
      const z0 = R.n(), z1 = R.n(), z2 = R.n(), z3 = R.n(), z4 = R.n();
      r = mission(se, i, c, (a) => { const t = a * D2R; return s3 * (z0 + z1 * Math.cos(t) + z2 * Math.sin(t) + z3 * Math.cos(2 * t) + z4 * Math.sin(2 * t)); }, false);
    } else r = mission(se, i, c, sig.terrainDeg * R.n(), false);
    if (r.ok) ok++; else counts[causeOf(r.fails[0])]++;
  }
  return ok / K;
}

/**
 * Chance of success when aiming at cell (ax, ay): the per-cell success shares
 * P (n x n, spacing s km) averaged with a circular normal distribution of
 * touchdown points (1-sigma = sigmaKm), cut at 3 sigma.
 */
export function aimProb(P: ArrayLike<number>, n: number, s: number, ax: number, ay: number, sigmaKm: number): { p: number; nEff: number } {
  let sw = 0, sp = 0, sw2 = 0; const r = Math.max(1, Math.ceil(3 * sigmaKm / s));
  for (let y = Math.max(0, ay - r); y <= Math.min(n - 1, ay + r); y++) for (let x = Math.max(0, ax - r); x <= Math.min(n - 1, ax + r); x++) {
    const d2 = ((x - ax) * (x - ax) + (y - ay) * (y - ay)) * s * s; if (d2 > 9 * sigmaKm * sigmaKm + 1e-9) continue;
    const w = Math.exp(-d2 / (2 * sigmaKm * sigmaKm)); sw += w; sw2 += w * w; sp += w * P[y * n + x];
  }
  return { p: sw ? sp / sw : 0, nEff: sw2 ? sw * sw / sw2 : 0 };
}

/** 95 % Wilson interval for a share p estimated from n (effective) trials. */
export function wilson(p: number, n: number): [number, number] {
  const z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface AimStats {
  p: number;
  /** Sampling variance of p. */
  var: number;
  nEff: number;
  lo: number;
  hi: number;
  /** false when the 3-sigma landing circle leaves the grid. */
  inside: boolean;
}

/** Like aimProb, plus the sampling variance: each cell's share comes from K trials, and cells count by their squared weight. */
export function aimStats(P: ArrayLike<number>, n: number, s: number, ax: number, ay: number, sigmaKm: number, K: number): AimStats {
  let sw = 0, sp = 0, sw2 = 0, v = 0; const r = Math.max(1, Math.ceil(3 * sigmaKm / s)), inside = ax - r >= 0 && ay - r >= 0 && ax + r <= n - 1 && ay + r <= n - 1;
  for (let y = Math.max(0, ay - r); y <= Math.min(n - 1, ay + r); y++) for (let x = Math.max(0, ax - r); x <= Math.min(n - 1, ax + r); x++) {
    const d2 = ((x - ax) * (x - ax) + (y - ay) * (y - ay)) * s * s; if (d2 > 9 * sigmaKm * sigmaKm + 1e-9) continue;
    const w = Math.exp(-d2 / (2 * sigmaKm * sigmaKm)), q = P[y * n + x]; sw += w; sw2 += w * w; sp += w * q; v += w * w * q * (1 - q) / K;
  }
  const p = sw ? sp / sw : 0, vr = sw ? v / (sw * sw) : 0, nEff = vr > 1e-9 && p > 0 && p < 1 ? p * (1 - p) / vr : K * (sw2 ? sw * sw / sw2 : 1), ci = wilson(p, Math.max(1, nEff));
  return { p, var: Math.max(vr, p * (1 - p) / Math.max(1, K * (sw2 ? sw * sw / sw2 : 1))), nEff, lo: ci[0], hi: ci[1], inside };
}
