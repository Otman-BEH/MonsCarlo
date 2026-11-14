// Landing-risk Monte Carlo: chance that a mission aimed at a point and time
// meets its power and comms needs, given touchdown, timing, terrain and
// hardware errors. Pure: no DOM, one result object for the UI to draw.
//
// Orchestration ported from runRisk in src/app.js of MonsCarlo-Best (MIT).
// Differences from his app, all switchable back with streams: "legacy":
//   - every cell and half has its own random stream, so changing the slope
//     limit or the grid no longer changes the draws of unrelated cells;
//   - the "what drives the risk" re-runs reuse the same draws as the main
//     run with one error source switched off (common random numbers) and
//     the full trial count, so the differences are like for like.
// Optional, off by default: spreads.terrainModel = "azimuth" (see monteCarlo.ts).

import type { EphemerisTable } from "./ephemeris";
import { verdict, type MissionConfig } from "./mission";
import { CAUSES, CAUSE_STEEP, aimStats, cellTrials, rng, type Spreads } from "./monteCarlo";
import { seriesAt, type FullSeries } from "./series";
import { MOON_RADIUS_M, TerrainModel, type LayerMeta } from "./terrain";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const RM = MOON_RADIUS_M / 1000;

export interface RiskInputs {
  terrain: TerrainModel;
  /** Hourly ephemeris table covering the landing time, the jitter padding and the mission. */
  table: EphemerisTable;
  /** Aim point. */
  latDeg: number;
  lonDeg: number;
  /** Row of the table at the planned landing time. */
  landingIndex: number;
  mission: MissionConfig;
  mastHeightM: number;
  /** Touchdown accuracy radius, treated as 3 sigma. Default 500 m. */
  accuracyM?: number;
  /** Landing time jitter, treated as 3 sigma. Default 2 h. */
  timeJitterH?: number;
  /** 1-sigma terrain horizon error, degrees. Default 0.15. */
  terrainDeg?: number;
  /** 1-sigma spreads in percent. Defaults 5, 5, 3. */
  powerPct?: number;
  loadPct?: number;
  capPct?: number;
  /** High loads and low battery capacity share one draw. Default false. */
  linked?: boolean;
  terrainModel?: "shift" | "azimuth";
  /** Cells steeper than this fail every trial. Default 12 degrees. */
  slopeLimitDeg?: number;
  /** Default 20261114. */
  seed?: number;
  /** Grid cells per side, odd. Default 15. */
  gridN?: number;
  /** Trials per cell, even. Default 48. */
  trials?: number;
  /** Azimuths per cell horizon. Default 180. */
  azimuthCount?: number;
  /** "perCell" (default) or "legacy" for his exact stream layout. */
  streams?: "perCell" | "legacy";
}

export interface RiskHooks {
  /** Called between grid rows with the fraction done, 0 to 1. */
  onProgress?: (fraction: number) => void;
  /** Return true to abandon the run; runRisk then resolves to null. */
  cancelled?: () => boolean;
}

export interface RiskDriver {
  label: string;
  /** Success chance with that error source switched off. */
  p: number;
}

export interface RiskBestAim {
  ix: number;
  iy: number;
  /** Success chance at the better aim point, judged on half B. */
  p: number;
  lo: number;
  hi: number;
  /** Gain over the current aim point on half B. */
  gain: number;
  /** true when it is a different cell, gains at least 3 points and the gain is significant. */
  clear: boolean;
  distKm: number;
  /** Bearing from the aim point, degrees clockwise from true north. */
  bearingDeg: number;
  lat: number;
  lon: number;
}

export interface RiskResult {
  available: true;
  /** Cells per side, cell spacing (km), grid half-width (km), accuracy radius (km), 1-sigma touchdown spread (km). */
  n: number;
  spacingKm: number;
  halfWidthKm: number;
  radiusKm: number;
  sigmaKm: number;
  /** Aim point in south polar stereographic map coordinates, km: +y toward lon 0, +x toward 90 E. */
  x0Km: number;
  y0Km: number;
  /** Per cell, row-major, row 0 at the +y edge: success share, deterministic verdict (0, 1, 2), position, slope. */
  P: Float32Array;
  det: Uint8Array;
  lat: Float64Array;
  lon: Float64Array;
  slopeDeg: Float32Array;
  /** Success chance at the aim point with its 95 % interval. */
  p: number;
  lo: number;
  hi: number;
  /** Share of weighted trials lost to each cause; same order as causeLabels. */
  causes: number[];
  causeLabels: readonly string[];
  best: RiskBestAim;
  drivers: RiskDriver[];
  /** Weighted share of the landing circle that is too steep. */
  steepShare: number;
  /** Total trials run in the main pass. */
  total: number;
  /** Terrain behind the slope gate and the near horizon. */
  terrain: {
    /** Layer and pixel size at the aim point. */
    layerAtAim: string | null;
    pixelSizeM: number | null;
    /** Share of grid cells whose ground comes from data of 100 m or finer. Below 1 the slope gate is partly blind. */
    fineShare: number;
  };
}

export type RiskOutcome = RiskResult | { available: false; reason: string };

function pixelSize(m: LayerMeta): number {
  return m.kind === "polar" ? m.pixel_size_m : (Math.PI * MOON_RADIUS_M) / 180 / m.pixels_per_degree;
}

/** Decorrelates a seed, a cell index and a stream id (murmur3 finaliser). */
function mix(seed: number, k: number, salt: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** Terrain model restricted to the layers that can matter for a grid around (xM, yM). */
function localModel(terrain: TerrainModel, xM: number, yM: number, reachM: number): TerrainModel {
  return new TerrainModel(terrain.layers.filter(({ meta: m }) => {
    if (m.kind !== "polar") return true;
    const dx = Math.max(m.x0_m - xM, 0, xM - (m.x0_m + m.width * m.pixel_size_m));
    const dy = Math.max(yM - m.y0_m, 0, m.y0_m - m.height * m.pixel_size_m - yM);
    return Math.hypot(dx, dy) <= m.max_range_m + reachM;
  }));
}

export function riskAvailable(terrain: TerrainModel, latDeg: number): string | null {
  if (!terrain.layers.some((l) => l.meta.kind === "polar")) return "no polar terrain layer is loaded";
  if (!(latDeg <= -80.05)) return "the landing-risk analysis only runs south of 80 S";
  return null;
}

export async function runRisk(inp: RiskInputs, hooks: RiskHooks = {}): Promise<RiskOutcome | null> {
  const why = riskAvailable(inp.terrain, inp.latDeg);
  if (why) return { available: false, reason: why };
  const tab = inp.table;
  if (Math.abs(tab.stepMs - 3600e3) > 1e-6) throw new Error("runRisk needs an hourly ephemeris table");
  const cfg = Object.assign({}, inp.mission), n = inp.gridN ?? 15, K = inp.trials ?? 48, half = K / 2;
  if (n % 2 !== 1 || K % 2 !== 0) throw new Error("gridN must be odd and trials even");
  const acc = inp.accuracyM ?? 500, tjit = inp.timeJitterH ?? 2, slopeLim = inp.slopeLimitDeg ?? 12, seed = inp.seed ?? 20261114;
  const legacy = inp.streams === "legacy", nAz = inp.azimuthCount ?? 180, eye = inp.mastHeightM;
  const Rkm = acc / 1000, W = 2.5 * Rkm, sp = 2 * W / (n - 1), sigma = Rkm / 3;
  const days24 = Math.round(cfg.days * 24);
  const J = Math.ceil(4 * tjit / 3) + 1, i0 = inp.landingIndex, start = Math.max(0, i0 - J), len = Math.min(tab.n - start, (i0 - start) + J + days24 + 1), is = i0 - start;
  const sig: Spreads = { timeH: tjit / 3, terrainDeg: inp.terrainDeg ?? 0.15, power: (inp.powerPct ?? 5) / 100, loads: (inp.loadPct ?? 5) / 100, cap: (inp.capPct ?? 3) / 100, linked: !!inp.linked, terrainModel: inp.terrainModel ?? "shift" };
  const rho0 = 2 * RM * Math.tan((90 + Math.max(-89.999, inp.latDeg)) / 2 * D2R), x0 = rho0 * Math.sin(inp.lonDeg * D2R), y0 = rho0 * Math.cos(inp.lonDeg * D2R);
  const T = localModel(inp.terrain, x0 * 1000, y0 * 1000, (W + 0.08) * 1000 * Math.SQRT2);
  const ll = (x: number, y: number): [number, number] => [Math.max(-89.999, -90 + 2 * Math.atan(Math.hypot(x, y) / (2 * RM)) * R2D), Math.atan2(x, y) * R2D];
  // terrain height (m) at map coordinates (km)
  const E = (x: number, y: number) => { const q = ll(x, y); return T.elevation(q[0], q[1]).elevationM; };
  // two independent halves of the draws: A picks the best aim point, B checks it, so the check is not biased by the choice
  const PA = new Float32Array(n * n), PB = new Float32Array(n * n), P = new Float32Array(n * n), det = new Uint8Array(n * n), cause = new Uint16Array(n * n * 6), lat = new Float64Array(n * n), lon = new Float64Array(n * n), slope = new Float32Array(n * n), sers: (FullSeries | undefined)[] = new Array(n * n);
  const RA = rng(seed), RB = rng((seed ^ 0x9E3779B9) >>> 0), c = (n - 1) / 2;
  const px = new Map(T.layers.map((l) => [l.meta.name, pixelSize(l.meta)]));
  let fine = 0, last = performance.now();
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const k = iy * n + ix, x = x0 + (ix - c) * sp, y = y0 + (c - iy) * sp;
      [lat[k], lon[k]] = ll(x, y);
      const src = T.elevation(lat[k], lon[k]).layer; if (src !== null && px.get(src)! <= 100) fine++;
      slope[k] = Math.atan(Math.hypot(E(x + 0.08, y) - E(x - 0.08, y), E(x, y + 0.08) - E(x, y - 0.08)) / 160) * R2D;
      if (slope[k] > slopeLim) { cause[k * 6 + CAUSE_STEEP] = K; continue; } // too steep to land on: every trial here fails
      const m = T.horizonProfile(lat[k], lon[k], eye, nAz), se = seriesAt(lat[k], lon[k], eye, m, tab, start, len), cs = cause.subarray(k * 6, k * 6 + 6);
      PA[k] = cellTrials(se, is, cfg, sig, legacy ? RA : rng(mix(seed, k, 0)), half, cs); PB[k] = cellTrials(se, is, cfg, sig, legacy ? RB : rng(mix(seed, k, 1)), half, cs); P[k] = (PA[k] + PB[k]) / 2; det[k] = verdict(se, is, cfg).state;
      if (Math.hypot(ix - c, iy - c) * sp <= Rkm + 1e-9) sers[k] = se;
    }
    if (performance.now() - last > 50) { hooks.onProgress?.((iy + 1) / n); await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }
    if (hooks.cancelled?.()) return null;
  }
  const cur = aimStats(P, n, sp, c, c, sigma, K), cw = [0, 0, 0, 0, 0, 0]; let sw = 0;
  const wts: [number, number][] = [];
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) { const d2 = ((ix - c) * (ix - c) + (iy - c) * (iy - c)) * sp * sp; if (d2 > Rkm * Rkm + 1e-9) continue; const w = Math.exp(-d2 / (2 * sigma * sigma)), k = iy * n + ix; wts.push([k, w]); sw += w; for (let j = 0; j < 6; j++) cw[j] += w * cause[k * 6 + j] / K; }
  // best aim point: chosen on half A, then judged on half B
  let pick = { p: aimStats(PA, n, sp, c, c, sigma, half).p, ix: c, iy: c };
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) { if (Math.hypot(ix - c, iy - c) * sp > 1.5 * Rkm + 1e-9) continue; const a = aimStats(PA, n, sp, ix, iy, sigma, half); if (a.inside && a.p > pick.p + 1e-9) pick = { p: a.p, ix, iy }; }
  const vb = aimStats(PB, n, sp, pick.ix, pick.iy, sigma, half), vc = aimStats(PB, n, sp, c, c, sigma, half), diff = vb.p - vc.p, se2 = Math.sqrt(vb.var + vc.var);
  const dx = (pick.ix - c) * sp, dy = (c - pick.iy) * sp, so = Math.sin(inp.lonDeg * D2R), co = Math.cos(inp.lonDeg * D2R);
  const best: RiskBestAim = { ix: pick.ix, iy: pick.iy, p: vb.p, lo: vb.lo, hi: vb.hi, gain: diff, clear: (pick.ix !== c || pick.iy !== c) && diff >= 0.03 && diff - 1.96 * se2 > 0, distKm: Math.hypot(dx, dy), bearingDeg: (Math.atan2(dx * co - dy * so, dx * so + dy * co) * R2D + 360) % 360, lat: lat[pick.iy * n + pick.ix], lon: lon[pick.iy * n + pick.ix] };
  // what drives the risk: repeat the draws with one source of error switched off
  const RD = rng((seed + 7919) >>> 0), dump = new Uint16Array(6);
  const without = (z: Partial<Spreads>) => {
    let sp2 = 0; const s2 = Object.assign({}, sig, z);
    for (const [k, w] of wts) {
      const se = sers[k]; if (!se) continue;
      sp2 += w * (legacy ? cellTrials(se, is, cfg, s2, RD, half, dump) : (cellTrials(se, is, cfg, s2, rng(mix(seed, k, 0)), half, dump) + cellTrials(se, is, cfg, s2, rng(mix(seed, k, 1)), half, dump)) / 2);
    }
    return sp2 / sw;
  };
  const drivers: RiskDriver[] = [
    { label: "An exact touchdown", p: P[c * n + c] },
    { label: "An exact landing time", p: without({ timeH: 0 }) },
    { label: "Perfect terrain data", p: without({ terrainDeg: 0 }) },
    { label: "Hardware exactly as specified", p: without({ power: 0, loads: 0, cap: 0 }) },
  ];
  let steep = 0; for (const [k, w] of wts) if (slope[k] > slopeLim) steep += w;
  const aimSrc = T.elevation(inp.latDeg, inp.lonDeg).layer;
  hooks.onProgress?.(1);
  return {
    available: true, n, spacingKm: sp, halfWidthKm: W, radiusKm: Rkm, sigmaKm: sigma, x0Km: x0, y0Km: y0, P, det, lat, lon, slopeDeg: slope,
    p: cur.p, lo: cur.lo, hi: cur.hi, causes: cw.map((v) => v / sw), causeLabels: CAUSES, best, drivers, steepShare: steep / sw, total: n * n * K,
    terrain: { layerAtAim: aimSrc, pixelSizeM: aimSrc === null ? null : px.get(aimSrc)!, fineShare: fine / (n * n) },
  };
}
