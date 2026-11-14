// Monte Carlo pieces: ports of the checks in build/test_core.js of
// MonsCarlo-Best (MIT), plus an exact comparison with values produced by his
// original analysis.js (fixtures/montecarlo_golden.json).

import { describe, expect, it } from "vitest";
import type { MissionConfig } from "../src/lib/mission";
import { aimProb, aimStats, cellTrials, rng, wilson, type Spreads } from "../src/lib/monteCarlo";
import type { Series } from "../src/lib/series";
import golden from "./fixtures/montecarlo_golden.json";

const N = 48;
const mk = (clr: (i: number) => number, e: (i: number) => number): Series => ({
  n: N,
  sunClr: Float32Array.from({ length: N }, (_, i) => clr(i)),
  earthClr: Float32Array.from({ length: N }, (_, i) => e(i)),
  sunEl: new Float32Array(N).fill(30),
  irr: new Float32Array(N).fill(1),
});
const cfg: MissionConfig = { days: 2, peakW: 400, loadSun: 100, loadDark: 50, capWh: 1000, minSoc: 0.2, tracking: true, needEarth: true, maxGapH: 6, margin: 0.3, chargeEff: 0.9 };
const sig0: Spreads = { timeH: 0, terrainDeg: 0, power: 0, loads: 0, cap: 0 };
const sig1: Spreads = { timeH: 1, terrainDeg: 0.15, power: 0.05, loads: 0.05, cap: 0.03 };

describe("random numbers", () => {
  it("repeat for the same seed", () => {
    const R1 = rng(42), R2 = rng(42);
    expect(R1.u()).toBe(R2.u());
    expect(R1.n()).toBe(R2.n());
  });
  it("give a standard normal", () => {
    let sm = 0, sq = 0;
    const RN = rng(7);
    for (let i = 0; i < 50000; i++) { const v = RN.n(); sm += v; sq += v * v; }
    expect(Math.abs(sm / 50000)).toBeLessThan(0.02);
    expect(Math.abs(sq / 50000 - 1)).toBeLessThan(0.03);
  });
});

describe("cell trials (ported checks)", () => {
  it("always succeed with wide margins and always fail in the dark", () => {
    let cnt = new Uint16Array(6);
    expect(cellTrials(mk(() => 5, () => 5), 0, cfg, sig1, rng(1), 200, cnt)).toBe(1);
    expect(cnt.every((v) => v === 0)).toBe(true);
    cnt = new Uint16Array(6);
    expect(cellTrials(mk(() => -5, () => 5), 0, cfg, sig1, rng(1), 200, cnt)).toBe(0);
    expect(cnt[0]).toBe(200);
  });
  it("split evenly at zero Earth clearance with symmetric terrain error", () => {
    const cnt = new Uint16Array(6);
    const pm = cellTrials(mk(() => 5, () => 0.0), 0, cfg, { ...sig0, terrainDeg: 0.15 }, rng(3), 4000, cnt);
    expect(Math.abs(pm - 0.5)).toBeLessThan(0.04);
    expect(cnt[1]).toBeGreaterThan(1500);
  });
  it("reproduce the deterministic pass with no spread", () => {
    expect(cellTrials(mk(() => 5, () => 5), 0, cfg, sig0, rng(1), 10, new Uint16Array(6))).toBe(1);
  });
  it("give a mixed outcome for independent and linked hardware errors", () => {
    const cc = new Uint16Array(6), se = mk((i) => (i < 20 ? 5 : -5), () => 5), c = { ...cfg, capWh: 1900 };
    const s: Spreads = { timeH: 0, terrainDeg: 0, power: 0, loads: 0.08, cap: 0.08 };
    const ind = cellTrials(se, 0, c, { ...s, linked: false }, rng(5), 3000, cc);
    const cor = cellTrials(se, 0, c, { ...s, linked: true }, rng(5), 3000, cc);
    expect(ind > 0.02 && ind < 0.98 && cor > 0.02 && cor < 0.98 && Math.abs(ind - cor) < 0.2).toBe(true);
  });
  it("azimuth terrain model keeps the same 1-sigma at any one azimuth", () => {
    const se = { ...mk(() => 5, () => 0.0), sunAz: new Float32Array(N).fill(40), earthAz: new Float32Array(N).fill(310) };
    const cnt = new Uint16Array(6);
    const pm = cellTrials(se, 0, { ...cfg, days: 1 / 24 }, { ...sig0, terrainDeg: 0.15, terrainModel: "azimuth" }, rng(3), 4000, cnt);
    expect(Math.abs(pm - 0.5)).toBeLessThan(0.04);
    // Earth clear by 0.15 deg = 1 sigma: about 84 % pass under either model
    const se2 = { ...se, earthClr: new Float32Array(N).fill(0.15) };
    const a = cellTrials(se2, 0, { ...cfg, days: 1 / 24 }, { ...sig0, terrainDeg: 0.15, terrainModel: "azimuth" }, rng(4), 6000, cnt);
    const b = cellTrials(se2, 0, { ...cfg, days: 1 / 24 }, { ...sig0, terrainDeg: 0.15 }, rng(4), 6000, cnt);
    expect(Math.abs(a - 0.841)).toBeLessThan(0.03);
    expect(Math.abs(b - 0.841)).toBeLessThan(0.03);
  });
});

describe("aim statistics (ported checks)", () => {
  it("aimProb follows the success map", () => {
    const PU = new Float32Array(81).fill(0.7);
    expect(aimProb(PU, 9, 0.1, 4, 4, 0.1).p).toBeCloseTo(0.7, 6);
    const PH = new Float32Array(81);
    for (let y = 0; y < 9; y++) for (let x = 5; x < 9; x++) PH[y * 9 + x] = 1;
    expect(aimProb(PH, 9, 0.1, 7, 4, 0.1).p).toBeGreaterThan(aimProb(PH, 9, 0.1, 4, 4, 0.1).p);
    expect(aimProb(PH, 9, 0.1, 4, 4, 0.1).p).toBeGreaterThan(aimProb(PH, 9, 0.1, 1, 4, 0.1).p);
    expect(aimProb(PH, 9, 0.1, 4, 4, 0.01).p).toBeCloseTo(0, 6);
    expect(aimProb(PH, 9, 0.1, 6, 4, 0.01).p).toBeCloseTo(1, 6);
  });
  it("Wilson interval", () => {
    const w = wilson(0.5, 100);
    expect(Math.abs(w[0] - 0.404)).toBeLessThan(0.002);
    expect(Math.abs(w[1] - 0.596)).toBeLessThan(0.002);
    const w0 = wilson(0, 50);
    expect(w0[0] === 0 && w0[1] > 0 && w0[1] < 0.1).toBe(true);
  });
  it("aimStats interval, edge flag and trial count", () => {
    const half = new Float32Array(81).fill(0.5);
    const st = aimStats(half, 9, 0.1, 4, 4, 0.1, 24);
    expect(st.p).toBeCloseTo(0.5, 9);
    expect(st.lo < 0.5 && st.hi > 0.5 && st.hi - st.lo < 0.2 && st.inside).toBe(true);
    expect(aimStats(half, 9, 0.1, 1, 4, 0.1, 24).inside).toBe(false);
    const many = aimStats(half, 9, 0.1, 4, 4, 0.1, 2400);
    expect(many.hi - many.lo).toBeLessThan(st.hi - st.lo);
  });
});

describe("same numbers as his analysis.js", () => {
  const G = golden as unknown as {
    N: number;
    series: Record<string, Record<"sunClr" | "earthClr" | "sunEl" | "irr", number[]>>;
    cfgs: Record<string, MissionConfig>;
    sigs: { timeH: number; terrainDeg: number; power: number; load: number; cap: number; corr: boolean }[];
    rng: { seed: number; u: number[]; n: number[] }[];
    trials: { s: string; c: string; sig: number; seed: number; p1: number; p2: number; counts: number[] }[];
    P: number[];
    aim: { ax: number; ay: number; sg: number; K: number; prob: { p: number; nEff: number }; stats: Record<string, number | boolean> }[];
    wilson: { p: number; n: number; ci: [number, number] }[];
  };
  it("rng", () => {
    for (const g of G.rng) {
      const R = rng(g.seed);
      expect([R.u(), R.u(), R.u()]).toEqual(g.u);
      expect([R.n(), R.n(), R.n(), R.n(), R.n()]).toEqual(g.n);
    }
  });
  it(`${G.trials.length} cellTrials runs match exactly, causes included`, () => {
    for (const t of G.trials) {
      const d = G.series[t.s];
      const se: Series = { n: G.N, sunClr: Float32Array.from(d.sunClr), earthClr: Float32Array.from(d.earthClr), sunEl: Float32Array.from(d.sunEl), irr: Float32Array.from(d.irr) };
      const s = G.sigs[t.sig];
      const sig: Spreads = { timeH: s.timeH, terrainDeg: s.terrainDeg, power: s.power, loads: s.load, cap: s.cap, linked: s.corr };
      const counts = new Uint16Array(6), R = rng(t.seed);
      const p1 = cellTrials(se, 40, G.cfgs[t.c], sig, R, 24, counts);
      const p2 = cellTrials(se, 90, G.cfgs[t.c], sig, R, 200, counts);
      expect({ p1, p2, counts: Array.from(counts) }, `${t.s} ${t.c} sig${t.sig} seed ${t.seed}`).toEqual({ p1: t.p1, p2: t.p2, counts: t.counts });
    }
  });
  it("aimProb, aimStats and wilson", () => {
    const P = Float32Array.from(G.P);
    for (const a of G.aim) {
      expect(aimProb(P, 15, 0.1786, a.ax, a.ay, a.sg)).toEqual(a.prob);
      expect(aimStats(P, 15, 0.1786, a.ax, a.ay, a.sg, a.K)).toEqual(a.stats);
    }
    for (const w of G.wilson) expect(wilson(w.p, w.n)).toEqual(w.ci);
  });
});
