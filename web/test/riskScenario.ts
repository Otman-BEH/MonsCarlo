// Synthetic terrain and mission shared by the series and landing-risk tests.

import { makeTable, type EphemerisTable } from "../src/lib/ephemeris";
import type { MissionConfig } from "../src/lib/mission";
import type { RiskInputs } from "../src/lib/risk";
import { MOON_RADIUS_M, TerrainModel, type PolarLayerMeta, type TerrainLayer } from "../src/lib/terrain";

const D2R = Math.PI / 180;

export function polarXY(lat: number, lon: number): [number, number] {
  const rho = 2 * MOON_RADIUS_M * Math.tan(((90 + lat) / 2) * D2R);
  return [rho * Math.sin(lon * D2R), rho * Math.cos(lon * D2R)];
}

/** Square polar layer centred on (cx, cy) with heights from a function of map metres. */
export function polarLayer(name: string, cx: number, cy: number, halfM: number, px: number, maxRange: number, h: (x: number, y: number) => number): TerrainLayer {
  const n = Math.round((2 * halfM) / px);
  const meta: PolarLayerMeta = { name, kind: "polar", file: name, width: n, height: n, x0_m: cx - halfM, y0_m: cy + halfM, pixel_size_m: px, step_m: px, max_range_m: maxRange, source: "test" };
  const data = new Int16Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) data[r * n + c] = Math.round(h(cx - halfM + (c + 0.5) * px, cy + halfM - (r + 0.5) * px));
  return { meta, data };
}

export const AIM = { lat: -89.5, lon: 30 };

/**
 * A rounded hill with the aim point on its summit plateau, a steep scarp on
 * its east side and a ridge to the north that hides the low Sun from the
 * lower cells. The 400 m layer carries the same shape, coarsened.
 */
export function hillHeight(x: number, y: number): number {
  const [ax, ay] = polarXY(AIM.lat, AIM.lon);
  const dx = x - ax, dy = y - ay;
  const hill = 260 * Math.exp(-(dx * dx + dy * dy) / (2 * 1100 * 1100));
  const scarp = dx > 300 ? -Math.min(400, (dx - 300) * 0.45) : 0;
  const ridge = 150 * Math.exp(-((dy - 2300) * (dy - 2300)) / (2 * 300 * 300));
  return hill + scarp + ridge;
}

export function hillTerrain(withPatch = true): TerrainModel {
  const [ax, ay] = polarXY(AIM.lat, AIM.lon);
  const layers = [polarLayer("polar_400m", 0, 0, 80000, 400, 60000, hillHeight)];
  if (withPatch) layers.push(polarLayer("patch_test_80m", ax, ay, 3040, 80, 3000, hillHeight));
  return new TerrainModel(layers);
}

export const T0 = Date.UTC(2026, 10, 14);
let cached: EphemerisTable | null = null;
/** 40 days of hourly ephemeris from 14 Nov 2026. */
export function hourlyTable(): EphemerisTable {
  return (cached ??= makeTable(T0, 3600e3, 40 * 24));
}

export const MISSION: MissionConfig = { days: 7, peakW: 400, loadSun: 120, loadDark: 60, capWh: 3000, minSoc: 0.2, tracking: true, needEarth: true, maxGapH: 12, margin: 0.3, chargeEff: 0.9 };

export function riskInputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return { terrain: hillTerrain(), table: hourlyTable(), latDeg: AIM.lat, lonDeg: AIM.lon, landingIndex: 0, mission: MISSION, mastHeightM: 2, ...over };
}
