// Coarse terrain in the browser: elevation lookup and horizon masks for custom
// coordinates. Listed sites should use their precomputed masks instead, which
// come from 5 m and 80 m data; this module works from 400 m, 1200 m and
// 1/4 degree layers packed by pipeline/build_browser_terrain.py.
//
// The ray casting follows pipeline/compute_horizon_masks.py: rays are great
// circles built from body-fixed unit vectors, elevation is exact on the
// sphere, every mast height reuses the same terrain samples, and a coarser
// layer counts only where every finer layer has no data at that range.
// The layer decoding is ported from src/terrain.js in MonsCarlo-Best (MIT).

import type { DemSource, HorizonMaskFile } from "./horizonMask";

export const MOON_RADIUS_M = 1737400;
export const NODATA = -32768;
export const DEFAULT_MAST_HEIGHTS_M = [0, 2, 5, 10, 20, 50, 100];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

interface LayerBase {
  name: string;
  file: string;
  width: number;
  height: number;
  /** Sample spacing along a ray, metres. */
  step_m: number;
  /** Farthest range sampled on this layer, metres. */
  max_range_m: number;
  source: string;
}

/** South polar stereographic raster; (x0_m, y0_m) is the outer corner of pixel (0, 0). */
export interface PolarLayerMeta extends LayerBase {
  kind: "polar";
  x0_m: number;
  y0_m: number;
  pixel_size_m: number;
}

/** Equirectangular raster; row 0 at +90, column 0 at -180, pixel centres at half steps. */
export interface GlobalLayerMeta extends LayerBase {
  kind: "global";
  pixels_per_degree: number;
}

export type LayerMeta = PolarLayerMeta | GlobalLayerMeta;

export interface TerrainManifest {
  schema_version: number;
  radius_m: number;
  nodata: number;
  layers: LayerMeta[];
}

export interface TerrainLayer {
  meta: LayerMeta;
  /** Heights in metres above the 1737.4 km sphere, row-major; NODATA where missing. */
  data: Int16Array;
}

/** Undo the row-delta, two-byte-plane packing. */
export function decodeLayer(bytes: Uint8Array, height: number, width: number): Int16Array {
  const n = height * width;
  if (bytes.length !== 2 * n) throw new Error(`terrain layer has ${bytes.length} bytes, expected ${2 * n}`);
  const out = new Int16Array(n);
  for (let r = 0; r < height; r++) {
    let acc = 0;
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      let v = bytes[i] | (bytes[n + i] << 8);
      if (v & 0x8000) v -= 0x10000;
      acc = c === 0 ? v : ((acc + v + 0x8000) & 0xffff) - 0x8000;
      out[i] = acc;
    }
  }
  return out;
}

/** Inverse of decodeLayer, without gzip. Used by tests. */
export function encodeLayer(data: Int16Array, height: number, width: number): Uint8Array {
  const n = height * width;
  const out = new Uint8Array(2 * n);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      const d = (c === 0 ? data[i] : data[i] - data[i - 1]) & 0xffff;
      out[i] = d & 0xff;
      out[n + i] = d >> 8;
    }
  }
  return out;
}

/** Gunzip if the bytes are gzip; pass through if a server already decompressed them. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads one file of the terrain folder and returns its bytes. */
export type TerrainReader = (file: string) => Promise<Uint8Array>;

/** Load every layer listed in the manifest. */
export async function loadTerrain(manifest: TerrainManifest, read: TerrainReader): Promise<TerrainModel> {
  const layers: TerrainLayer[] = [];
  for (const meta of manifest.layers) {
    const raw = await gunzipIfNeeded(await read(meta.file));
    layers.push({ meta, data: decodeLayer(raw, meta.height, meta.width) });
  }
  return new TerrainModel(layers);
}

/** Browser entry point: fetches terrain.json and its layers from a folder URL. */
export async function loadTerrainFromUrl(baseUrl: string): Promise<TerrainModel> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const res = await fetch(base + "terrain.json");
  if (!res.ok) throw new Error(`terrain manifest: HTTP ${res.status}`);
  const manifest = (await res.json()) as TerrainManifest;
  return loadTerrain(manifest, async (file) => {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  });
}

export interface HorizonOptions {
  mastHeightsM?: number[];
  /** Number of azimuths, evenly spaced from north. Default 720. */
  azimuthCount?: number;
  siteId?: string;
  siteName?: string;
}

export interface ElevationSample {
  elevationM: number;
  /** Name of the layer that supplied the value, or null if no layer has data there. */
  layer: string | null;
}

/** Horizon for one mast height: elevation of the terrain skyline per azimuth, evenly spaced from north. */
export interface HorizonProfile {
  elevationDeg: Float32Array;
  /** Ground height above the 1737.4 km sphere at the site, metres. */
  groundM: number;
}

interface ProfileTier {
  layer: TerrainLayer;
  step: number;
  n: number;
  cg: Float64Array;
  sg: Float64Array;
  valid: Uint8Array;
}

export class TerrainModel {
  /** Layers ordered fine to coarse by ray step. */
  readonly layers: TerrainLayer[];

  private profileTiers: ProfileTier[] | null = null;

  constructor(layers: TerrainLayer[]) {
    this.layers = [...layers].sort((a, b) => a.meta.step_m - b.meta.step_m);
  }

  /** Bilinear height on one layer at a body-fixed unit vector; NaN outside or next to missing data. */
  static sample(layer: TerrainLayer, qx: number, qy: number, qz: number): number {
    const m = layer.meta;
    const a = layer.data;
    if (m.kind === "polar") {
      if (qz > -0.2) return NaN; // far from the south pole: outside any polar layer
      const s = (2 * MOON_RADIUS_M) / (1 - qz);
      const col = (s * qy - m.x0_m) / m.pixel_size_m - 0.5;
      const row = (m.y0_m - s * qx) / m.pixel_size_m - 0.5;
      if (!(col >= 0 && row >= 0 && col <= m.width - 1 && row <= m.height - 1)) return NaN;
      const c0 = Math.min(Math.floor(col), m.width - 2);
      const r0 = Math.min(Math.floor(row), m.height - 2);
      const fc = col - c0;
      const fr = row - r0;
      const i = r0 * m.width + c0;
      const v00 = a[i];
      const v01 = a[i + 1];
      const v10 = a[i + m.width];
      const v11 = a[i + m.width + 1];
      if (v00 === NODATA || v01 === NODATA || v10 === NODATA || v11 === NODATA) return NaN;
      return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
    }
    const lat = Math.asin(Math.max(-1, Math.min(1, qz))) * R2D;
    const lon = Math.atan2(qy, qx) * R2D;
    const ppd = m.pixels_per_degree;
    let r = (90 - lat) * ppd - 0.5;
    if (r < 0) r = 0;
    if (r > m.height - 1) r = m.height - 1;
    const c = ((((lon + 180) % 360) + 360) % 360) * ppd - 0.5;
    const r0 = Math.min(Math.floor(r), m.height - 2);
    const fr = r - r0;
    const cf = Math.floor(c);
    const fc = c - cf;
    const c0 = ((cf % m.width) + m.width) % m.width;
    const c1 = (c0 + 1) % m.width;
    const i0 = r0 * m.width;
    const i1 = i0 + m.width;
    const v00 = a[i0 + c0];
    const v01 = a[i0 + c1];
    const v10 = a[i1 + c0];
    const v11 = a[i1 + c1];
    if (v00 === NODATA || v01 === NODATA || v10 === NODATA || v11 === NODATA) return NaN;
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
  }

  /** Terrain height at a point from the finest layer that has data there. */
  elevation(latDeg: number, lonDeg: number): ElevationSample {
    const la = latDeg * D2R;
    const lo = lonDeg * D2R;
    const qx = Math.cos(la) * Math.cos(lo);
    const qy = Math.cos(la) * Math.sin(lo);
    const qz = Math.sin(la);
    for (const layer of this.layers) {
      const h = TerrainModel.sample(layer, qx, qy, qz);
      if (Number.isFinite(h)) return { elevationM: h, layer: layer.meta.name };
    }
    return { elevationM: 0, layer: null };
  }

  /**
   * Fast path for the landing-risk grid: the horizon for one mast height as a
   * bare Float32Array (degrees, not rounded), plus the ground height. Same
   * ray casting as horizonMask(), which stays the reference; the range
   * tables are built once per model and reused for every cell.
   */
  horizonProfile(latDeg: number, lonDeg: number, mastHeightM: number, azimuthCount = 180): HorizonProfile {
    const R = MOON_RADIUS_M;
    const la = latDeg * D2R;
    const lo = lonDeg * D2R;
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    const co = Math.cos(lo);
    const so = Math.sin(lo);
    const px = cl * co;
    const py = cl * so;
    const pz = sl;
    const ground = this.elevation(latDeg, lonDeg).elevationM;
    const r0 = R + ground + mastHeightM;
    if (!this.profileTiers) {
      this.profileTiers = this.layers.map((layer) => {
        const step = layer.meta.step_m;
        const n = Math.max(0, Math.floor(layer.meta.max_range_m / step + 1e-9));
        const cg = new Float64Array(n);
        const sg = new Float64Array(n);
        for (let j = 0; j < n; j++) {
          const g = (step * (j + 1)) / R;
          cg[j] = Math.cos(g);
          sg[j] = Math.sin(g);
        }
        return { layer, step, n, cg, sg, valid: new Uint8Array(n) };
      });
    }
    const tiers = this.profileTiers;
    const out = new Float32Array(azimuthCount);
    for (let ia = 0; ia < azimuthCount; ia++) {
      const az = ((ia * 360) / azimuthCount) * D2R;
      const ca = Math.cos(az);
      const sa = Math.sin(az);
      const dx = -sl * co * ca - so * sa;
      const dy = -sl * so * ca + co * sa;
      const dz = cl * ca;
      let best = -Infinity; // tangent of the elevation angle; atan is taken once per azimuth
      for (let ti = 0; ti < tiers.length; ti++) {
        const t = tiers[ti];
        for (let j = 0; j < t.n; j++) {
          const cg = t.cg[j];
          const sg = t.sg[j];
          const h = TerrainModel.sample(t.layer, px * cg + dx * sg, py * cg + dy * sg, pz * cg + dz * sg);
          if (h !== h) {
            t.valid[j] = 0;
            continue;
          }
          t.valid[j] = 1;
          const range = t.step * (j + 1);
          let covered = false;
          for (let fi = 0; fi < ti && !covered; fi++) {
            const f = tiers[fi];
            const idx = Math.round(range / f.step) - 1;
            covered = idx >= 0 && idx < f.n && f.valid[idx] === 1;
          }
          if (covered) continue;
          const r1 = R + h;
          const tan = (r1 * cg - r0) / (r1 * sg);
          if (tan > best) best = tan;
        }
      }
      out[ia] = best === -Infinity ? (r0 > R ? -Math.acos(R / r0) * R2D : 0) : Math.atan(best) * R2D;
    }
    return { elevationDeg: out, groundM: ground };
  }

  /**
   * Horizon mask for any coordinate, in the same shape as the precomputed
   * site files. Azimuth is clockwise from true north; at a pole it follows
   * the longitude passed in.
   */
  horizonMask(latDeg: number, lonDeg: number, options: HorizonOptions = {}): HorizonMaskFile {
    const masts = options.mastHeightsM ?? DEFAULT_MAST_HEIGHTS_M;
    const nAz = options.azimuthCount ?? 720;
    const nM = masts.length;
    const R = MOON_RADIUS_M;
    const la = latDeg * D2R;
    const lo = lonDeg * D2R;
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    const co = Math.cos(lo);
    const so = Math.sin(lo);
    const p = [cl * co, cl * so, sl];
    const north = [-sl * co, -sl * so, cl];
    const east = [-so, co, 0];
    const ground = this.elevation(latDeg, lonDeg).elevationM;
    const r0 = masts.map((m) => R + ground + m);

    const tiers = this.layers.map((layer) => {
      const step = layer.meta.step_m;
      const n = Math.max(0, Math.floor(layer.meta.max_range_m / step + 1e-9));
      const cg = new Float64Array(n);
      const sg = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        const g = (step * (j + 1)) / R; // first sample one step out, never zero range
        cg[j] = Math.cos(g);
        sg[j] = Math.sin(g);
      }
      return { layer, step, n, cg, sg, valid: new Uint8Array(n), count: 0 };
    });

    const best = masts.map(() => new Float64Array(nAz).fill(-Infinity));
    const bestD = masts.map(() => new Float64Array(nAz));
    const bestT = new Int16Array(nAz).fill(-1);

    for (let ia = 0; ia < nAz; ia++) {
      const az = (ia * 360) / nAz;
      const ca = Math.cos(az * D2R);
      const sa = Math.sin(az * D2R);
      const dx = north[0] * ca + east[0] * sa;
      const dy = north[1] * ca + east[1] * sa;
      const dz = north[2] * ca + east[2] * sa;
      for (let ti = 0; ti < tiers.length; ti++) {
        const t = tiers[ti];
        for (let j = 0; j < t.n; j++) {
          const cg = t.cg[j];
          const sg = t.sg[j];
          const h = TerrainModel.sample(t.layer, p[0] * cg + dx * sg, p[1] * cg + dy * sg, p[2] * cg + dz * sg);
          if (!Number.isFinite(h)) {
            t.valid[j] = 0;
            continue;
          }
          t.valid[j] = 1;
          const range = t.step * (j + 1);
          let covered = false;
          for (let fi = 0; fi < ti && !covered; fi++) {
            const f = tiers[fi];
            const idx = Math.round(range / f.step) - 1;
            covered = idx >= 0 && idx < f.n && f.valid[idx] === 1;
          }
          if (covered) continue;
          const r1 = R + h;
          const a = r1 * cg;
          const b = r1 * sg;
          for (let mi = 0; mi < nM; mi++) {
            const el = Math.atan2(a - r0[mi], b);
            if (el > best[mi][ia]) {
              best[mi][ia] = el;
              bestD[mi][ia] = range;
              if (mi === 0) bestT[ia] = ti;
            }
          }
        }
      }
      if (bestT[ia] >= 0) tiers[bestT[ia]].count++;
      for (let mi = 0; mi < nM; mi++) {
        if (best[mi][ia] === -Infinity) {
          // No terrain data on this ray: smooth sphere dip.
          best[mi][ia] = r0[mi] > R ? -Math.acos(R / r0[mi]) : 0;
        }
      }
    }

    const demSources: DemSource[] = tiers.map((t) => ({
      file: t.layer.meta.file,
      role: t.layer.meta.kind === "polar" ? "browser_polar" : "browser_global",
      pixel_size_m:
        t.layer.meta.kind === "polar"
          ? t.layer.meta.pixel_size_m
          : Math.round((Math.PI * R) / 180 / t.layer.meta.pixels_per_degree),
      max_range_m: t.layer.meta.max_range_m,
      horizon_azimuth_count: t.count,
    }));
    const lon360 = ((lonDeg % 360) + 360) % 360;
    return {
      schema_version: 2,
      site_id: options.siteId ?? "custom",
      site_name: options.siteName ?? `Custom ${latDeg.toFixed(4)}, ${lon360.toFixed(4)} E`,
      lat: latDeg,
      lon: lon360,
      elevation_m: Math.round(ground * 100) / 100,
      snap_mode: "custom",
      nominal_lat: latDeg,
      nominal_lon: lon360,
      frame: "MOON_ME",
      radius_m: R,
      dem_sources: demSources,
      generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      azimuth_deg: Array.from({ length: nAz }, (_, i) => (i * 360) / nAz),
      masks: masts.map((m, mi) => ({
        mast_height_m: m,
        horizon_elevation_deg: Array.from(best[mi], (v) => Math.round(v * R2D * 1e4) / 1e4),
        horizon_distance_m: Array.from(bestD[mi], (v) => Math.round(v)),
      })),
    };
  }
}
