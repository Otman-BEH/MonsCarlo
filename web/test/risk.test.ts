// Landing-risk Monte Carlo on synthetic terrain (test/riskScenario.ts).

import { describe, expect, it } from "vitest";
import { makeTable } from "../src/lib/ephemeris";
import { riskAvailable, runRisk, type RiskInputs, type RiskResult } from "../src/lib/risk";
import { TerrainModel } from "../src/lib/terrain";
import { AIM, T0, hillTerrain, riskInputs } from "./riskScenario";

const LANDING = 100;
async function run(over: Partial<RiskInputs> = {}): Promise<RiskResult> {
  const r = await runRisk(riskInputs({ landingIndex: LANDING, ...over }));
  if (!r || !r.available) throw new Error("risk run did not complete");
  return r;
}
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

describe("landing risk", () => {
  it("only runs south of 80 S on polar terrain", async () => {
    expect(riskAvailable(hillTerrain(), -79.9)).toMatch(/80 S/);
    expect(riskAvailable(new TerrainModel([]), -89)).toMatch(/polar/);
    const r = await runRisk(riskInputs({ latDeg: -75 }));
    expect(r && !r.available).toBe(true);
    await expect(runRisk(riskInputs({ table: makeTable(T0, 1800e3, 48) }))).rejects.toThrow(/hourly/);
  });

  it("seeded regression (seed 20261114, default settings)", async () => {
    const r = await run();
    expect(r.n).toBe(15);
    expect(r.total).toBe(15 * 15 * 48);
    expect(r.spacingKm).toBeCloseTo(2.5 / 14, 12);
    expect(r.terrain).toEqual({ layerAtAim: "patch_test_80m", pixelSizeM: 80, fineShare: 1 });
    expect({
      p: r6(r.p), lo: r6(r.lo), hi: r6(r.hi), causes: r.causes.map(r6), steep: r6(r.steepShare),
      best: { ix: r.best.ix, iy: r.best.iy, p: r6(r.best.p), gain: r6(r.best.gain), clear: r.best.clear, dist: r6(r.best.distKm), bearing: r6(r.best.bearingDeg) },
      drivers: r.drivers.map((d) => r6(d.p)),
      sumP: r6(r.P.reduce((a, b) => a + b, 0)), det: Array.from(r.det).join(""),
    }).toMatchInlineSnapshot(`
      {
        "best": {
          "bearing": 315.963757,
          "clear": true,
          "dist": 0.736269,
          "gain": 0.103987,
          "ix": 6,
          "iy": 3,
          "p": 0.98502,
        },
        "causes": [
          0.039363,
          0.041031,
          0,
          0,
          0.039802,
          0,
        ],
        "det": "000000000000000000001221000000000022222000000000012222000000000002222000000000002222000000000000222000000000000222000000000000222000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "drivers": [
          1,
          0.881253,
          0.880594,
          0.879804,
        ],
        "hi": 0.882239,
        "lo": 0.877325,
        "p": 0.879804,
        "steep": 0.039802,
        "sumP": 30.583333,
      }
    `);
  });

  it("repeats for the same seed and moves a little for another", async () => {
    const a = await run(), b = await run(), c = await run({ seed: 1 });
    expect(Array.from(b.P)).toEqual(Array.from(a.P));
    expect(b.p).toBe(a.p);
    expect(Array.from(c.P)).not.toEqual(Array.from(a.P));
    expect(Math.abs(c.p - a.p)).toBeLessThan(0.05);
  });

  it("fails steep cells outright without disturbing the draws of other cells", async () => {
    const a = await run(), b = await run({ slopeLimitDeg: 6 });
    let steepA = 0, steepB = 0;
    for (let k = 0; k < a.P.length; k++) {
      if (a.slopeDeg[k] > 12) { steepA++; expect(a.P[k]).toBe(0); expect(a.det[k]).toBe(0); }
      if (b.slopeDeg[k] > 6) steepB++;
      else expect(b.P[k]).toBe(a.P[k]); // same cell, same stream, same answer
    }
    expect(steepA).toBeGreaterThan(0);
    expect(steepB).toBeGreaterThan(steepA);
    const c = await run({ slopeLimitDeg: 2 });
    expect(c.steepShare).toBeGreaterThan(a.steepShare);
    expect(c.causes[4]).toBeCloseTo(c.steepShare, 9);
    expect(c.p).toBeLessThan(a.p);
  });

  it("accounts for every weighted trial as a success or a named cause", async () => {
    const r = await run({ slopeLimitDeg: 6 });
    expect(r.p + r.causes.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(r.lo).toBeLessThanOrEqual(r.p);
    expect(r.hi).toBeGreaterThanOrEqual(r.p);
    expect(r.causeLabels.length).toBe(6);
  });

  it("drivers reuse the main draws: switching off a source that is already zero changes nothing", async () => {
    const r = await run({ terrainDeg: 0, timeJitterH: 0 });
    expect(r.drivers.map((d) => d.label)).toEqual(["An exact touchdown", "An exact landing time", "Perfect terrain data", "Hardware exactly as specified"]);
    expect(r.drivers[1].p).toBeCloseTo(r.p, 6);
    expect(r.drivers[2].p).toBeCloseTo(r.p, 6);
    expect(r.drivers[0].p).toBe(r.P[7 * 15 + 7]);
  });

  it("offers a better aim point only as a different cell with a real gain", async () => {
    const r = await run();
    if (r.best.clear) {
      expect(r.best.ix !== 7 || r.best.iy !== 7).toBe(true);
      expect(r.best.gain).toBeGreaterThanOrEqual(0.03);
      expect(r.best.distKm).toBeLessThanOrEqual(1.5 * r.radiusKm + 1e-9);
      expect(r.best.distKm).toBeCloseTo(Math.hypot(r.best.ix - 7, r.best.iy - 7) * r.spacingKm, 9);
    }
    expect(r.lat[7 * 15 + 7]).toBeCloseTo(AIM.lat, 9);
    expect(r.lon[7 * 15 + 7]).toBeCloseTo(AIM.lon, 9);
    expect(r.lat[0]).not.toBe(r.lat[14]);
  });

  it("legacy streams and the azimuth terrain model run and stay close to the default", async () => {
    const a = await run(), l = await run({ streams: "legacy" }), z = await run({ terrainModel: "azimuth" });
    expect(Math.abs(l.p - a.p)).toBeLessThan(0.05);
    expect(Math.abs(z.p - a.p)).toBeLessThan(0.1);
    expect(Array.from(l.det)).toEqual(Array.from(a.det)); // the deterministic verdicts do not depend on the draws
  });

  it("flags coarse terrain when there is no fine patch", async () => {
    const r = await run({ terrain: hillTerrain(false) });
    expect(r.terrain.fineShare).toBe(0);
    expect(r.terrain.pixelSizeM).toBe(400);
  });

  it("reports progress and can be cancelled", async () => {
    let lastFraction = 0;
    await runRisk(riskInputs({ landingIndex: LANDING }), { onProgress: (f) => (lastFraction = f) });
    expect(lastFraction).toBe(1);
    expect(await runRisk(riskInputs({ landingIndex: LANDING }), { cancelled: () => true })).toBeNull();
  });
});
