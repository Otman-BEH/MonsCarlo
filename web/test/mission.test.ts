// Mission model: ports of the mission, stress-test and safe-mode checks in
// build/test_core.js of MonsCarlo-Best (MIT), plus an exact comparison with
// values produced by his original analysis.js (fixtures/montecarlo_golden.json).

import { describe, expect, it } from "vitest";
import { fracAt, mission, verdict, type MissionConfig, type MissionResult } from "../src/lib/mission";
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

describe("mission model (ported checks)", () => {
  it("passes when always lit and linked", () => {
    const r = mission(mk(() => 5, () => 5), 0, cfg, 0, true);
    expect(r.ok && r.minSoc === 1 && r.maxGapH === 0 && r.battNeedWh === 0).toBe(true);
  });
  it("drains the battery in darkness and sizes the battery needed", () => {
    let r = mission(mk((i) => (i < 24 ? 5 : -5), () => 5), 0, cfg, 0, false);
    expect(r.minSoc).toBeCloseTo(0, 9);
    expect(!r.ok && /battery/.test(r.fails.join())).toBe(true);
    r = mission(mk((i) => (i < 24 ? 5 : -5), () => 5), 0, { ...cfg, capWh: 2000 }, 0, false);
    expect(r.minSoc).toBeCloseTo(0.4, 6);
    expect(r.ok).toBe(true);
    expect(r.battNeedWh).toBeCloseTo(1200 / 0.8, 6);
  });
  it("applies the Earth gap limit only to direct-to-Earth missions", () => {
    const se = mk(() => 5, (i) => (i >= 10 && i < 20 ? -1 : 5));
    const r = mission(se, 0, cfg, 0, false);
    expect(!r.ok && r.maxGapH === 10).toBe(true);
    expect(mission(se, 0, { ...cfg, needEarth: false }, 0, false).ok).toBe(true);
  });
  it("fails a landing in darkness and a mission past the table end", () => {
    expect(mission(mk(() => -5, () => 5), 0, cfg, 0, false).ok).toBe(false);
    expect(mission(mk(() => 5, () => 5), 40, cfg, 0, false).ok).toBe(false);
  });
  it("grades the verdict by the terrain margin", () => {
    expect(verdict(mk(() => 0.2, () => 5), 0, cfg).state).toBe(1);
    expect(verdict(mk(() => 2, () => 5), 0, cfg).state).toBe(2);
    expect(verdict(mk(() => -2, () => 5), 0, cfg).state).toBe(0);
  });
  it("handles the single-fault stress test and safe mode", () => {
    const dark24 = mk((i) => (i < 12 || i >= 36 ? 5 : -5), () => 5);
    const c2 = { ...cfg, capWh: 3000 };
    expect(mission(dark24, 0, c2, 0, false).ok).toBe(true);
    const f: MissionConfig = { ...c2, fault: { kind: "battery", day: 0.25 } };
    expect(mission(dark24, 0, f, 0, false).minSoc).toBeLessThan(mission(dark24, 0, c2, 0, false).minSoc);
    const fl: MissionConfig = { ...cfg, capWh: 2600, fault: { kind: "load", day: 0 } };
    const a = mission(dark24, 0, fl, 0, true);
    const b = mission(dark24, 0, { ...fl, safe: true }, 0, true);
    expect(b.minSoc >= a.minSoc && b.safeH >= 0 && b.safeArr!.length === 48).toBe(true);
    expect(mission(dark24, 0, { ...cfg, fault: { kind: "none", day: 1 } }, 0, false).faultK).toBe(-1);
    const arr = mission(mk(() => 5, () => 5), 0, { ...cfg, peakW: 120, fault: { kind: "array", day: 1 } }, 0, true);
    expect(arr.soc![24] === 1 && arr.soc![47] < 1).toBe(true);
    const ant = mission(mk(() => 5, () => 5), 0, { ...cfg, fault: { kind: "antenna", day: 0.5 } }, 0, false);
    expect(ant.maxGapH === 24 && !ant.ok).toBe(true);
  });
});

describe("mission model (additions)", () => {
  it("uses the series' own solar radius when present", () => {
    const se = mk(() => 0.1, () => 5);
    expect(fracAt(se, 0, 0)).toBeCloseTo(fracAt({ ...se, sunRad: new Float32Array(N).fill(0.266) }, 0, 0), 6);
    expect(fracAt({ ...se, sunRad: new Float32Array(N).fill(0.5) }, 0, 0)).toBeLessThan(fracAt(se, 0, 0));
  });
  it("accepts a margin that depends on azimuth", () => {
    const se = { ...mk(() => 0.5, () => 0.5), sunAz: new Float32Array(N).fill(90), earthAz: new Float32Array(N).fill(270) };
    expect(mission(se, 0, cfg, () => 0.2, false)).toEqual(mission(se, 0, cfg, 0.2, false));
    const r = mission(se, 0, cfg, (az) => (az > 180 ? 1 : 0), false); // error only toward the Earth
    expect(r.fails.some((f) => /Earth/.test(f)) && !r.fails.some((f) => /Sun/.test(f))).toBe(true);
    expect(() => mission(mk(() => 5, () => 5), 0, cfg, () => 0, false)).toThrow();
  });
});

describe("mission model (same numbers as his analysis.js)", () => {
  const G = golden as unknown as {
    N: number;
    series: Record<string, Record<"sunClr" | "earthClr" | "sunEl" | "irr", number[]>>;
    cfgs: Record<string, MissionConfig>;
    missions: { s: string; c: string; i0: number; margin: number; r: Record<string, unknown> }[];
    verdicts: { s: string; i0: number; state: number }[];
  };
  const ser = (s: string): Series => {
    const d = G.series[s];
    return { n: G.N, sunClr: Float32Array.from(d.sunClr), earthClr: Float32Array.from(d.earthClr), sunEl: Float32Array.from(d.sunEl), irr: Float32Array.from(d.irr) };
  };
  it(`${G.missions.length} missions match field for field`, () => {
    for (const m of G.missions) {
      const r = mission(ser(m.s), m.i0, G.cfgs[m.c], m.margin, true);
      const got: Record<string, unknown> = {};
      for (const k of Object.keys(r) as (keyof MissionResult)[]) {
        const v = r[k];
        got[k] = ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v;
      }
      expect(got, `${m.s} ${m.c} i0=${m.i0}`).toEqual(m.r);
    }
  });
  it("verdicts match", () => {
    for (const v of G.verdicts) expect(verdict(ser(v.s), v.i0, G.cfgs.base).state).toBe(v.state);
  });
});
