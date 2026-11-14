// Sun and Earth over a terrain horizon for a table of epochs.
//
// Ported from stateWith / seriesAt / series in src/analysis.js of
// MonsCarlo-Best (MIT). Ephemeris, masks and terrain come from this project's
// own modules. One addition: the series keeps the Sun's apparent radius per
// sample, so the mission model can use it instead of a fixed 0.266 degrees.

import {
  EARTH_RADIUS_KM,
  SUN_RADIUS_KM,
  discFraction,
  look,
  siteBasis,
  type EphemerisTable,
  type Vec3,
} from "./ephemeris";
import { layerForMast, type HorizonMaskFile } from "./horizonMask";

const AU_KM = 149597870.7;

/** Terrain skyline for one mast height: degrees per azimuth, evenly spaced clockwise from north. */
export interface Horizon {
  elevationDeg: ArrayLike<number>;
  /** Ground height above the 1737.4 km sphere, metres. */
  groundM: number;
}

/** Horizon for a mast height from a precomputed or custom mask file. */
export function horizonFromMask(mask: HorizonMaskFile, mastHeightM: number): Horizon {
  return { elevationDeg: Float32Array.from(layerForMast(mask, mastHeightM).horizon_elevation_deg), groundM: mask.elevation_m };
}

/** Skyline elevation at any azimuth by linear interpolation around the circle. */
export function skylineAt(h: ArrayLike<number>, azimuthDeg: number): number {
  const n = h.length;
  const x = ((((azimuthDeg % 360) + 360) % 360) * n) / 360;
  const i = Math.floor(x) % n;
  const f = x - Math.floor(x);
  return h[i] * (1 - f) + h[(i + 1) % n] * f;
}

export interface SkyState {
  sunEl: number;
  sunAz: number;
  sunRad: number;
  /** Terrain horizon under the Sun, degrees. */
  sunHz: number;
  /** Sun centre above the terrain horizon, degrees. */
  sunClr: number;
  /** Visible fraction of the solar disc, 0 to 1. */
  sunFrac: number;
  earthEl: number;
  earthAz: number;
  earthRad: number;
  earthHz: number;
  earthClr: number;
  groundM: number;
  /** Solar irradiance relative to 1 AU. */
  irr: number;
}

/** Sun and Earth state at one instant from body-fixed vectors (km) and a horizon. */
export function stateWith(latDeg: number, lonDeg: number, mastHeightM: number, hz: Horizon, sun: Vec3, earth: Vec3): SkyState {
  const lat = Math.max(-89.999, Math.min(89.999, latDeg));
  const b = siteBasis(lat, lonDeg, hz.groundM + mastHeightM);
  const s = look(b, sun, SUN_RADIUS_KM);
  const e = look(b, earth, EARTH_RADIUS_KM);
  const hs = skylineAt(hz.elevationDeg, s.azimuthDeg);
  const he = skylineAt(hz.elevationDeg, e.azimuthDeg);
  return {
    sunEl: s.elevationDeg, sunAz: s.azimuthDeg, sunRad: s.angularRadiusDeg, sunHz: hs, sunClr: s.elevationDeg - hs,
    sunFrac: discFraction(s.elevationDeg, s.angularRadiusDeg, hs),
    earthEl: e.elevationDeg, earthAz: e.azimuthDeg, earthRad: e.angularRadiusDeg, earthHz: he, earthClr: e.elevationDeg - he,
    groundM: hz.groundM, irr: (AU_KM / s.distanceKm) * (AU_KM / s.distanceKm),
  };
}

/** Per-sample arrays. Only n, sunEl, sunClr, earthClr and irr are needed by the mission model. */
export interface Series {
  n: number;
  sunEl: Float32Array;
  sunClr: Float32Array;
  earthClr: Float32Array;
  irr: Float32Array;
  sunAz?: Float32Array;
  sunFrac?: Float32Array;
  /** Apparent solar radius, degrees. When absent the mission model uses 0.266. */
  sunRad?: Float32Array;
  earthEl?: Float32Array;
  earthAz?: Float32Array;
}

export type FullSeries = Required<Series>;

/** Series for samples [start, start + n) of a table. */
export function seriesAt(
  latDeg: number, lonDeg: number, mastHeightM: number, hz: Horizon, table: EphemerisTable, start: number, n: number,
): FullSeries {
  const a = table.data;
  const o: FullSeries = {
    n, sunEl: new Float32Array(n), sunAz: new Float32Array(n), sunClr: new Float32Array(n), sunFrac: new Float32Array(n),
    sunRad: new Float32Array(n), earthEl: new Float32Array(n), earthAz: new Float32Array(n), earthClr: new Float32Array(n),
    irr: new Float32Array(n),
  };
  const sv: Vec3 = [0, 0, 0];
  const ev: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const k = (start + i) * 6;
    sv[0] = a[k]; sv[1] = a[k + 1]; sv[2] = a[k + 2];
    ev[0] = a[k + 3]; ev[1] = a[k + 4]; ev[2] = a[k + 5];
    const s = stateWith(latDeg, lonDeg, mastHeightM, hz, sv, ev);
    o.sunEl[i] = s.sunEl; o.sunAz[i] = s.sunAz; o.sunClr[i] = s.sunClr; o.sunFrac[i] = s.sunFrac; o.sunRad[i] = s.sunRad;
    o.earthEl[i] = s.earthEl; o.earthAz[i] = s.earthAz; o.earthClr[i] = s.earthClr; o.irr[i] = s.irr;
  }
  return o;
}

/** Series for the whole table. */
export function series(latDeg: number, lonDeg: number, mastHeightM: number, hz: Horizon, table: EphemerisTable): FullSeries {
  return seriesAt(latDeg, lonDeg, mastHeightM, hz, table, 0, table.n);
}
