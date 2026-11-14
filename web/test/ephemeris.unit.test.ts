// Geometry checks for the ephemeris module. Adapted from build/test_core.js in MonsCarlo-Best (MIT).

import { describe, expect, it } from "vitest";
import {
  EARTH_RADIUS_KM,
  SUN_RADIUS_KM,
  bodyFixed,
  discFraction,
  look,
  makeTable,
  siteBasis,
  skyAt,
  subPoint,
  tableState,
  type Vec3,
} from "../src/lib/ephemeris";

const T0 = Date.UTC(2026, 10, 14);
const DAY = 86400e3;

describe("disc fraction", () => {
  it("handles full, empty, half and partial discs", () => {
    expect(discFraction(1, 0.266, 0)).toBe(1);
    expect(discFraction(-1, 0.266, 0)).toBe(0);
    expect(discFraction(0.5, 0.266, 0.5)).toBeCloseTo(0.5, 9);
    const partial = discFraction(0.1, 0.266, 0);
    expect(partial).toBeGreaterThan(0.5);
    expect(partial).toBeLessThan(1);
  });
});

describe("body-fixed vectors", () => {
  it("keeps the sub-Earth point inside the libration range", () => {
    for (let k = 0; k < 400; k++) {
      const p = subPoint(bodyFixed(T0 + k * DAY * 1.37).earth);
      expect(Math.abs(p.latDeg)).toBeLessThan(7);
      expect(Math.abs(p.lonDeg)).toBeLessThan(8.3);
    }
  });
  it("keeps the sub-solar latitude within the lunar axial tilt", () => {
    for (let k = 0; k < 400; k++) {
      expect(Math.abs(subPoint(bodyFixed(T0 + k * DAY * 1.37).sun).latDeg)).toBeLessThan(1.62);
    }
  });
  it("gives plausible distances and angular sizes", () => {
    const sky = skyAt(siteBasis(0, 0, 0), bodyFixed(T0));
    expect(sky.sun.distanceKm).toBeGreaterThan(1.45e8);
    expect(sky.sun.distanceKm).toBeLessThan(1.53e8);
    expect(sky.earth.distanceKm).toBeGreaterThan(3.5e5);
    expect(sky.earth.distanceKm).toBeLessThan(4.1e5);
    expect(sky.sun.angularRadiusDeg).toBeGreaterThan(0.25);
    expect(sky.sun.angularRadiusDeg).toBeLessThan(0.28);
    expect(sky.earth.angularRadiusDeg).toBeGreaterThan(0.88);
    expect(sky.earth.angularRadiusDeg).toBeLessThan(1.05);
  });
});

describe("site geometry", () => {
  const b = siteBasis(-45, 30, 0);
  const scaled = (v: Vec3, s: number, plusUp = 0): Vec3 => [
    v[0] * s + b.up[0] * plusUp,
    v[1] * s + b.up[1] * plusUp,
    v[2] * s + b.up[2] * plusUp,
  ];
  it("puts a body straight overhead at 90 deg", () => {
    expect(look(b, scaled(b.up, 4e5), 1).elevationDeg).toBeCloseTo(90, 6);
  });
  it("puts a body in the horizontal plane at 0 deg, with north at azimuth 0 and east at 90", () => {
    const north = look(b, scaled(b.north, 1e9, b.radiusKm), 1);
    const east = look(b, scaled(b.east, 1e9, b.radiusKm), 1);
    expect(north.elevationDeg).toBeCloseTo(0, 6);
    expect(Math.min(north.azimuthDeg, 360 - north.azimuthDeg)).toBeCloseTo(0, 6);
    expect(east.azimuthDeg).toBeCloseTo(90, 6);
  });
  it("lowers the Earth by parallax as the site moves away from the sub-Earth point", () => {
    const state = bodyFixed(T0);
    const sub = subPoint(state.earth);
    const under = look(siteBasis(sub.latDeg, sub.lonDeg, 0), state.earth, EARTH_RADIUS_KM);
    expect(under.elevationDeg).toBeCloseTo(90, 3);
    // (lat 0, lon + 90) is exactly 90 deg of arc from the sub-Earth point.
    const limb = look(siteBasis(0, sub.lonDeg + 90, 0), state.earth, EARTH_RADIUS_KM);
    expect(limb.elevationDeg).toBeLessThan(0); // about -0.26 deg: one lunar radius of parallax
    expect(limb.elevationDeg).toBeGreaterThan(-0.4);
  });
  it("evaluates the south pole without NaN", () => {
    const sky = skyAt(siteBasis(-90, 0, 0), bodyFixed(T0));
    for (const v of [sky.sun.elevationDeg, sky.sun.azimuthDeg, sky.earth.elevationDeg, sky.earth.azimuthDeg]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(look(siteBasis(-90, 0, 0), [1e6, 0, 0], SUN_RADIUS_KM).azimuthDeg).toBeCloseTo(0, 6);
  });
});

describe("ephemeris table", () => {
  it("reproduces bodyFixed at each row", () => {
    const table = makeTable(T0, 3600e3, 48);
    const direct = bodyFixed(T0 + 17 * 3600e3);
    const row = tableState(table, 17);
    expect(row.sun).toEqual(direct.sun);
    expect(row.earth).toEqual(direct.earth);
  });
});
