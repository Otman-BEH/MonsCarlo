// Time-series layer: Sun and Earth clearance over a horizon for a table of epochs.

import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, discFraction, look, makeTable, siteBasis, tableState } from "../src/lib/ephemeris";
import { horizonFromMask, series, seriesAt, skylineAt, stateWith, type Horizon } from "../src/lib/series";
import { AIM, hillTerrain, hourlyTable } from "./riskScenario";

const flat: Horizon = { elevationDeg: new Float32Array(180), groundM: 0 };

describe("series", () => {
  it("over a level horizon reduces to the bare look angles", () => {
    const tab = hourlyTable();
    const b = siteBasis(-85, 40, 2);
    for (const i of [0, 137, 600]) {
      const st = tableState(tab, i);
      const s = stateWith(-85, 40, 2, flat, st.sun, st.earth);
      const ls = look(b, st.sun, SUN_RADIUS_KM), le = look(b, st.earth, EARTH_RADIUS_KM);
      expect(s.sunClr).toBeCloseTo(ls.elevationDeg, 12);
      expect(s.sunAz).toBeCloseTo(ls.azimuthDeg, 12);
      expect(s.earthClr).toBeCloseTo(le.elevationDeg, 12);
      expect(s.sunFrac).toBeCloseTo(discFraction(ls.elevationDeg, ls.angularRadiusDeg, 0), 12);
      expect(s.irr).toBeGreaterThan(0.96);
      expect(s.irr).toBeLessThan(1.04);
      expect(Math.abs(s.sunRad - 0.266)).toBeLessThan(0.01);
    }
  });
  it("subtracts the skyline under each body", () => {
    const tab = hourlyTable(), st = tableState(tab, 50);
    const hz: Horizon = { elevationDeg: Float32Array.from({ length: 360 }, (_, i) => (i < 180 ? 1 : 3)), groundM: 0 };
    const a = stateWith(-85, 40, 2, flat, st.sun, st.earth), b = stateWith(-85, 40, 2, hz, st.sun, st.earth);
    expect(a.sunClr - b.sunClr).toBeCloseTo(skylineAt(hz.elevationDeg, a.sunAz), 9);
    expect(a.earthClr - b.earthClr).toBeCloseTo(skylineAt(hz.elevationDeg, a.earthAz), 9);
    expect(skylineAt([0, 2, 0, 0], 45)).toBeCloseTo(1, 12);
    expect(skylineAt([4, 0, 0, 0], 315)).toBeCloseTo(2, 12);
  });
  it("is finite at the pole and a window equals a slice of the whole", () => {
    const tab = makeTable(Date.UTC(2026, 10, 14), 3600e3, 10 * 24);
    const pole = series(-90, 0, 2, flat, tab);
    expect(pole.sunClr.every(Number.isFinite) && pole.earthClr.every(Number.isFinite)).toBe(true);
    const w = seriesAt(-90, 0, 2, flat, tab, 30, 50);
    expect(w.n).toBe(50);
    expect(Array.from(w.sunClr)).toEqual(Array.from(pole.sunClr.subarray(30, 80)));
    expect(Array.from(w.earthAz)).toEqual(Array.from(pole.earthAz.subarray(30, 80)));
  });
  it("accepts a mask file, and the fast terrain path agrees with it", () => {
    const T = hillTerrain();
    const file = T.horizonMask(AIM.lat, AIM.lon, { azimuthCount: 180 });
    const fromFile = horizonFromMask(file, 3.5); // between the stored 2 m and 5 m masts
    const fast = T.horizonProfile(AIM.lat, AIM.lon, 3.5, 180);
    expect(fast.groundM).toBeCloseTo(fromFile.groundM, 1);
    let worst = 0;
    for (let i = 0; i < 180; i++) worst = Math.max(worst, Math.abs(fast.elevationDeg[i] - fromFile.elevationDeg[i]));
    expect(worst).toBeLessThan(0.02); // mast interpolation only
    const exact = T.horizonMask(AIM.lat, AIM.lon, { azimuthCount: 180, mastHeightsM: [3.5] }).masks[0].horizon_elevation_deg;
    for (let i = 0; i < 180; i++) expect(Math.abs(fast.elevationDeg[i] - exact[i])).toBeLessThan(1e-4);
  });
});
