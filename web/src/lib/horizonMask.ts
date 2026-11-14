// Types for the horizon mask JSON (schema_version 2).
// Precomputed sites: data/horizon_masks/<site_id>.json and index.json, written
// by pipeline/compute_horizon_masks.py. Custom coordinates: the same shape,
// built in the browser by terrain.ts with snap_mode "custom".

export type SnapMode = "exact" | "peak" | "custom";
export type DemRole = "site_tile" | "regional" | "far" | "browser_polar" | "browser_global";

export interface DemSource {
  file: string;
  role: DemRole;
  pixel_size_m: number;
  /** Farthest range sampled on this source. */
  max_range_m: number;
  /** Number of azimuths whose 0 m mast horizon comes from this source. */
  horizon_azimuth_count: number;
}

export interface HorizonMaskLayer {
  mast_height_m: number;
  /** Terrain horizon elevation above the local horizontal, degrees. Index matches azimuth_deg. */
  horizon_elevation_deg: number[];
  /** Arc distance along the reference sphere to the terrain point that sets the horizon, metres. */
  horizon_distance_m: number[];
}

export interface HorizonMaskFile {
  schema_version: number;
  site_id: string;
  site_name: string;
  /** Planetocentric latitude of the site, degrees, negative south. */
  lat: number;
  /** East longitude of the site, degrees, 0 to 360. */
  lon: number;
  /** Ground height above the 1737.4 km sphere, metres. */
  elevation_m: number;
  snap_mode: SnapMode;
  nominal_lat: number;
  nominal_lon: number;
  frame: "MOON_ME";
  radius_m: number;
  dem_sources: DemSource[];
  /** ISO 8601, UTC. */
  generated_utc: string;
  /** Clockwise from true north, evenly spaced from 0. 720 values for precomputed sites. */
  azimuth_deg: number[];
  /** One entry per mast height: 0, 2, 5, 10, 20, 50, 100 m for precomputed sites. */
  masks: HorizonMaskLayer[];
}

export interface HorizonMaskIndexEntry {
  site_id: string;
  site_name: string;
  lat: number;
  lon: number;
  elevation_m: number;
  snap_mode: SnapMode;
  /** File name relative to index.json. */
  file: string;
}

export interface HorizonMaskIndex {
  schema_version: number;
  generated_utc: string;
  frame: "MOON_ME";
  radius_m: number;
  mast_heights_m: number[];
  sites: HorizonMaskIndexEntry[];
}

/** Horizon elevation at any azimuth by linear interpolation around the circle. */
export function horizonAt(layer: HorizonMaskLayer, azimuthDeg: number): number {
  const h = layer.horizon_elevation_deg;
  const n = h.length;
  const x = ((((azimuthDeg % 360) + 360) % 360) * n) / 360;
  const i = Math.floor(x) % n;
  const f = x - Math.floor(x);
  return h[i] * (1 - f) + h[(i + 1) % n] * f;
}

/** Mask layer for a mast height, linearly interpolated between the stored heights. */
export function layerForMast(mask: HorizonMaskFile, mastHeightM: number): HorizonMaskLayer {
  const layers = [...mask.masks].sort((a, b) => a.mast_height_m - b.mast_height_m);
  if (mastHeightM <= layers[0].mast_height_m) return layers[0];
  const last = layers[layers.length - 1];
  if (mastHeightM >= last.mast_height_m) return last;
  let k = 0;
  while (mastHeightM > layers[k + 1].mast_height_m) k++;
  const a = layers[k];
  const b = layers[k + 1];
  const f = (mastHeightM - a.mast_height_m) / (b.mast_height_m - a.mast_height_m);
  return {
    mast_height_m: mastHeightM,
    horizon_elevation_deg: a.horizon_elevation_deg.map((v, i) => v * (1 - f) + b.horizon_elevation_deg[i] * f),
    horizon_distance_m: f < 0.5 ? a.horizon_distance_m : b.horizon_distance_m,
  };
}
