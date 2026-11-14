// Checks for the in-browser terrain and custom-coordinate ray casting.
// Synthetic tests mirror --verify in pipeline/compute_horizon_masks.py.
// Tests on packed data run only when web/public/data/terrain exists; the
// comparison with precomputed masks also needs data/horizon_masks.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HorizonMaskFile } from "../src/lib/horizonMask";
import { horizonAt, layerForMast } from "../src/lib/horizonMask";
import {
  MOON_RADIUS_M,
  NODATA,
  TerrainModel,
  decodeLayer,
  encodeLayer,
  loadTerrain,
  type PolarLayerMeta,
  type TerrainLayer,
  type TerrainManifest,
} from "../src/lib/terrain";

const R = MOON_RADIUS_M;
const D2R = Math.PI / 180;

function polarXY(lat: number, lon: number): [number, number] {
  const rho = 2 * R * Math.tan(((90 + lat) / 2) * D2R);
  return [rho * Math.sin(lon * D2R), rho * Math.cos(lon * D2R)];
}

/** Zero-height square polar layer centred on the pole. */
function flatPolar(halfM: number, px: number, maxRange: number): TerrainLayer {
  const n = Math.round((2 * halfM) / px);
  const meta: PolarLayerMeta = {
    name: "synthetic", kind: "polar", file: "synthetic", width: n, height: n,
    x0_m: -halfM, y0_m: halfM, pixel_size_m: px, step_m: px, max_range_m: maxRange, source: "test",
  };
  return { meta, data: new Int16Array(n * n) };
}

function addGaussian(layer: TerrainLayer, cx: number, cy: number, peak: number, sigma: number): void {
  const m = layer.meta as PolarLayerMeta;
  for (let r = 0; r < m.height; r++) {
    const y = m.y0_m - (r + 0.5) * m.pixel_size_m;
    for (let c = 0; c < m.width; c++) {
      const x = m.x0_m + (c + 0.5) * m.pixel_size_m;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < 36 * sigma * sigma) layer.data[r * m.width + c] = Math.round(peak * Math.exp(-d2 / (2 * sigma * sigma)));
    }
  }
}

describe("layer packing", () => {
  it("round-trips heights, including negative values, big jumps and nodata", () => {
    const w = 7;
    const h = 3;
    const a = Int16Array.from([
      0, 1, -1, 32767, -32767, NODATA, 5,
      -9000, 10000, -9000, 10000, 0, 0, 1,
      NODATA, NODATA, 12, -12, 300, -300, 7,
    ]);
    expect(Array.from(decodeLayer(encodeLayer(a, h, w), h, w))).toEqual(Array.from(a));
  });
});

describe("custom-coordinate ray casting on synthetic terrain", () => {
  it("matches the smooth-sphere dip on a flat Moon", () => {
    const model = new TerrainModel([flatPolar(152_000, 400, 330_000)]);
    const mask = model.horizonMask(-89, 45, { mastHeightsM: [10, 1000], azimuthCount: 72 });
    [10, 1000].forEach((h, mi) => {
      const expected = -Math.acos(R / (R + h)) / D2R;
      const errs = mask.masks[mi].horizon_elevation_deg.map((v) => Math.abs(v - expected));
      expect(Math.max(...errs)).toBeLessThan(0.001);
      const tangent = R * Math.acos(R / (R + h));
      for (const d of mask.masks[mi].horizon_distance_m) expect(Math.abs(d - tangent)).toBeLessThan(450);
    });
  });

  it("finds a peak due north at azimuth 0 and due east at azimuth 90", () => {
    const lat = -89;
    const lon = 45;
    // North: same meridian, 10 km closer to the equator. East: textbook destination formula at bearing 90.
    const northLat = lat + (10_000 / R) / D2R;
    const g = 10_000 / R;
    const eastLat = Math.asin(Math.sin(lat * D2R) * Math.cos(g)) / D2R;
    const eastLon = lon + Math.atan2(Math.sin(g) * Math.cos(lat * D2R), Math.cos(g) - Math.sin(lat * D2R) * Math.sin(eastLat * D2R)) / D2R;
    const cases: [number, number, number][] = [[northLat, lon, 0], [eastLat, eastLon, 90]];
    for (const [plat, plon, bearing] of cases) {
      const layer = flatPolar(100_000, 400, 60_000);
      const [px, py] = polarXY(plat, plon);
      addGaussian(layer, px, py, 3000, 1500);
      const mask = new TerrainModel([layer]).horizonMask(lat, lon, { mastHeightsM: [2] });
      const el = mask.masks[0].horizon_elevation_deg;
      const azMax = mask.azimuth_deg[el.indexOf(Math.max(...el))];
      const diff = Math.abs(((azMax - bearing + 540) % 360) - 180);
      expect(diff).toBeLessThanOrEqual(0.5);
      expect(Math.max(...el)).toBeGreaterThan(10);
    }
  });

  it("never raises the horizon when the mast gets taller", () => {
    const layer = flatPolar(100_000, 400, 60_000);
    const [px, py] = polarXY(-88.8, 60);
    addGaussian(layer, px, py, 2500, 3000);
    const mask = new TerrainModel([layer]).horizonMask(-89, 45, { azimuthCount: 90 });
    for (let mi = 1; mi < mask.masks.length; mi++) {
      mask.masks[mi].horizon_elevation_deg.forEach((v, i) => {
        expect(v).toBeLessThanOrEqual(mask.masks[mi - 1].horizon_elevation_deg[i] + 1e-9);
      });
    }
  });

  it("falls through to a coarser layer where the fine layer has no data", () => {
    const fine = flatPolar(20_000, 400, 60_000); // small patch around the pole
    const coarse = flatPolar(200_000, 1200, 330_000);
    coarse.meta.name = "coarse";
    const [px, py] = polarXY(-88.5, 0); // about 45 km from the pole, outside the fine patch
    addGaussian(coarse, px, py, 4000, 4000);
    const mask = new TerrainModel([fine, coarse]).horizonMask(-90, 0, { mastHeightsM: [2] });
    const el = mask.masks[0].horizon_elevation_deg;
    expect(Math.max(...el)).toBeGreaterThan(3);
    expect(mask.azimuth_deg[el.indexOf(Math.max(...el))]).toBe(0); // at the pole with lon 0, azimuth 0 looks along 0 E
    expect(mask.dem_sources[1].horizon_azimuth_count).toBeGreaterThan(0);
  });

  it("interpolates masks between stored mast heights and azimuths", () => {
    const model = new TerrainModel([flatPolar(100_000, 400, 330_000)]);
    const mask = model.horizonMask(-89.5, 10, { mastHeightsM: [0, 10], azimuthCount: 36 });
    const mid = layerForMast(mask, 5);
    const a = mask.masks[0].horizon_elevation_deg[3];
    const b = mask.masks[1].horizon_elevation_deg[3];
    expect(mid.horizon_elevation_deg[3]).toBeCloseTo((a + b) / 2, 9);
    expect(horizonAt(mask.masks[1], 35)).toBeCloseTo(
      (mask.masks[1].horizon_elevation_deg[3] + mask.masks[1].horizon_elevation_deg[4]) / 2, 9);
  });
});

const terrainDir = fileURLToPath(new URL("../public/data/terrain/", import.meta.url));
const maskDir = fileURLToPath(new URL("../../data/horizon_masks/", import.meta.url));
const hasTerrain = existsSync(terrainDir + "terrain.json");

describe.skipIf(!hasTerrain)("packed terrain layers", () => {
  const load = async () => {
    const manifest = JSON.parse(readFileSync(terrainDir + "terrain.json", "utf8")) as TerrainManifest;
    const present = { ...manifest, layers: manifest.layers.filter((l) => existsSync(terrainDir + l.file)) };
    return loadTerrain(present, async (file) => new Uint8Array(readFileSync(terrainDir + file)));
  };

  it("loads and returns finite heights, with longitude wrap", async () => {
    const model = await load();
    console.log("terrain layers: " + model.layers.map((l) => `${l.meta.name} (${l.meta.width} x ${l.meta.height})`).join(", "));
    expect(model.layers.length).toBeGreaterThan(0);
    const global = model.layers.some((l) => l.meta.kind === "global");
    const polar = model.layers.some((l) => l.meta.kind === "polar");
    if (polar) {
      expect(model.elevation(-89.9, 10).layer).not.toBeNull();
      expect(model.elevation(-85, 180).elevationM).toBeCloseTo(model.elevation(-85, -180).elevationM, 6);
    }
    if (global) {
      for (const [la, lo] of [[90, 0], [-90, 0], [0, 180], [0, -180], [10, 359.99]]) {
        const s = model.elevation(la, lo);
        expect(s.layer).not.toBeNull();
        expect(Number.isFinite(s.elevationM)).toBe(true);
      }
      expect(model.elevation(10, 180).elevationM).toBeCloseTo(model.elevation(10, -180).elevationM, 6);
      // Known heights above the 1737.4 km sphere (same references as MonsCarlo-Best).
      expect(Math.abs(model.elevation(0.6741, 23.473).elevationM - -1918)).toBeLessThan(80); // Apollo 11
      expect(model.elevation(5.44, -158.69).elevationM).toBeGreaterThan(9000); // highest region on the Moon
    }
  });

  it.skipIf(!existsSync(maskDir + "index.json"))(
    "custom masks agree with the precomputed site masks at a 10 m mast",
    async () => {
      const model = await load();
      const index = JSON.parse(readFileSync(maskDir + "index.json", "utf8")) as { sites: { site_id: string; file: string }[] };
      const lines = ["site                 mean |diff|   max |diff|   (deg, custom coarse layers vs precomputed, 10 m mast)"];
      const means: Record<string, number> = {};
      for (const entry of index.sites) {
        const ref = JSON.parse(readFileSync(maskDir + entry.file, "utf8")) as HorizonMaskFile;
        const custom = model.horizonMask(ref.lat, ref.lon, { mastHeightsM: [10], azimuthCount: 360 });
        const refLayer = layerForMast(ref, 10);
        let sum = 0;
        let max = 0;
        custom.masks[0].horizon_elevation_deg.forEach((v, i) => {
          const d = Math.abs(v - horizonAt(refLayer, custom.azimuth_deg[i]));
          sum += d;
          max = Math.max(max, d);
        });
        means[entry.site_id] = sum / 360;
        lines.push(`${entry.site_id.padEnd(20)} ${(sum / 360).toFixed(3).padStart(11)} ${max.toFixed(3).padStart(12)}`);
      }
      console.log(lines.join("\n"));
      // Open sites on broad terrain must agree closely; sharp peaks are reported, not asserted.
      for (const id of ["im2_mons_mouton", "chandrayaan3"]) {
        if (id in means) expect(means[id]).toBeLessThan(1.0);
      }
    },
    60_000,
  );
});
