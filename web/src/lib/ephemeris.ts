// Sun and Earth as seen from a site on the Moon.
//
// Ported from src/engine.js in MonsCarlo-Best (MIT). Positions come from
// astronomy-engine; the Moon's orientation is the IAU pole and prime meridian
// model that astronomy-engine exposes through RotationAxis. That model follows
// the mean Earth / polar axis (ME) frame used by the LOLA terrain, and is
// checked against JPL SPICE (DE440, MOON_ME) in test/ephemeris.truth.test.ts.
//
// Units: vectors and distances in km, angles in degrees, site height in metres.

import * as Astronomy from "astronomy-engine";

export type Vec3 = [number, number, number];

export const MOON_RADIUS_KM = 1737.4;
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6378.137;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const AU_KM = 149597870.7;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Moon-centred position vectors in the Moon body-fixed frame, km. */
export interface BodyFixedState {
  sun: Vec3;
  earth: Vec3;
}

/** Sun and Earth vectors in the Moon body-fixed frame at a Date or a Unix time in ms. */
export function bodyFixed(time: Date | number): BodyFixedState {
  const t = Astronomy.MakeTime(typeof time === "number" ? new Date(time) : time);
  const m = Astronomy.GeoMoon(t); // geocentric Moon, J2000 equatorial, AU
  const s = Astronomy.GeoVector(Astronomy.Body.Sun, t, true); // geocentric Sun, light time and aberration
  const ax = Astronomy.RotationAxis(Astronomy.Body.Moon, t); // IAU lunar pole and prime meridian angle
  const a0 = ax.ra * 15 * D2R;
  const w = ax.spin * D2R;
  const p: Vec3 = [ax.north.x, ax.north.y, ax.north.z];
  const node: Vec3 = [-Math.sin(a0), Math.cos(a0), 0]; // node of the lunar equator on the J2000 equator
  const mAxis = cross(p, node);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const x: Vec3 = [node[0] * cw + mAxis[0] * sw, node[1] * cw + mAxis[1] * sw, node[2] * cw + mAxis[2] * sw];
  const y = cross(p, x);
  const sv: Vec3 = [(s.x - m.x) * AU_KM, (s.y - m.y) * AU_KM, (s.z - m.z) * AU_KM];
  const ev: Vec3 = [-m.x * AU_KM, -m.y * AU_KM, -m.z * AU_KM];
  return {
    sun: [dot(sv, x), dot(sv, y), dot(sv, p)],
    earth: [dot(ev, x), dot(ev, y), dot(ev, p)],
  };
}

/** Local up, true north and east unit vectors at a site, plus its radius from the Moon's centre. */
export interface SiteBasis {
  up: Vec3;
  north: Vec3;
  east: Vec3;
  radiusKm: number;
}

/**
 * Site basis in the body-fixed frame. heightM is ground elevation plus mast
 * height above the 1737.4 km sphere. At lat = -90 or +90 the basis is defined
 * by the longitude passed in; use lon = 0 for the south_pole site so that
 * azimuths match its precomputed horizon mask.
 */
export function siteBasis(latDeg: number, lonDeg: number, heightM = 0): SiteBasis {
  const la = latDeg * D2R;
  const lo = lonDeg * D2R;
  const cl = Math.cos(la);
  const sl = Math.sin(la);
  const co = Math.cos(lo);
  const so = Math.sin(lo);
  return {
    up: [cl * co, cl * so, sl],
    north: [-sl * co, -sl * so, cl],
    east: [-so, co, 0],
    radiusKm: MOON_RADIUS_KM + heightM / 1000,
  };
}

export interface Look {
  /** Elevation of the body centre above the local horizontal, degrees. */
  elevationDeg: number;
  /** Azimuth clockwise from true north, degrees, 0 to 360. */
  azimuthDeg: number;
  /** Apparent angular radius of the body, degrees. */
  angularRadiusDeg: number;
  /** Distance from the site to the body centre, km. */
  distanceKm: number;
}

/** Topocentric direction of a body-fixed vector seen from the site (parallax included). */
export function look(basis: SiteBasis, bodyKm: Vec3, bodyRadiusKm: number): Look {
  const x = bodyKm[0] - basis.radiusKm * basis.up[0];
  const y = bodyKm[1] - basis.radiusKm * basis.up[1];
  const z = bodyKm[2] - basis.radiusKm * basis.up[2];
  const d = Math.hypot(x, y, z);
  const u = (x * basis.up[0] + y * basis.up[1] + z * basis.up[2]) / d;
  const n = (x * basis.north[0] + y * basis.north[1] + z * basis.north[2]) / d;
  const e = (x * basis.east[0] + y * basis.east[1] + z * basis.east[2]) / d;
  let az = Math.atan2(e, n) * R2D;
  if (az < 0) az += 360;
  return {
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, u))) * R2D,
    azimuthDeg: az,
    angularRadiusDeg: Math.asin(bodyRadiusKm / d) * R2D,
    distanceKm: d,
  };
}

export interface Sky {
  sun: Look;
  earth: Look;
}

/** Sun and Earth directions from a site for one body-fixed state. */
export function skyAt(basis: SiteBasis, state: BodyFixedState): Sky {
  return {
    sun: look(basis, state.sun, SUN_RADIUS_KM),
    earth: look(basis, state.earth, EARTH_RADIUS_KM),
  };
}

export interface SubPoint {
  /** Planetocentric latitude, degrees. */
  latDeg: number;
  /** East longitude, degrees, -180 to 180. */
  lonDeg: number;
  distanceKm: number;
}

/** Sub-solar or sub-Earth point of a body-fixed vector. */
export function subPoint(v: Vec3): SubPoint {
  const d = Math.hypot(v[0], v[1], v[2]);
  return { latDeg: Math.asin(v[2] / d) * R2D, lonDeg: Math.atan2(v[1], v[0]) * R2D, distanceKm: d };
}

/** Site-independent table of body-fixed vectors: [sx, sy, sz, ex, ey, ez] per step, km. */
export interface EphemerisTable {
  t0Ms: number;
  stepMs: number;
  n: number;
  data: Float64Array;
}

/** Compute the table once; every site and every custom coordinate then reuses it. */
export function makeTable(t0Ms: number, stepMs: number, n: number): EphemerisTable {
  const data = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const b = bodyFixed(t0Ms + i * stepMs);
    data.set(b.sun, i * 6);
    data.set(b.earth, i * 6 + 3);
  }
  return { t0Ms, stepMs, n, data };
}

/** Body-fixed state at table row i. */
export function tableState(table: EphemerisTable, i: number): BodyFixedState {
  const a = table.data;
  const k = i * 6;
  return { sun: [a[k], a[k + 1], a[k + 2]], earth: [a[k + 3], a[k + 4], a[k + 5]] };
}

/** Fraction of a disc (centre elevation, angular radius) above a straight horizon, 0 to 1. */
export function discFraction(centreElevationDeg: number, radiusDeg: number, horizonDeg: number): number {
  const d = (centreElevationDeg - horizonDeg) / radiusDeg;
  if (d >= 1) return 1;
  if (d <= -1) return 0;
  return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}
