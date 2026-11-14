// Ephemeris check against JPL SPICE (DE440, MOON_ME).
// The reference table is written by pipeline/make_ephemeris_truth.py.
// Adapted from build/validate.js in MonsCarlo-Best (MIT).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bodyFixed, siteBasis, skyAt, subPoint } from "../src/lib/ephemeris";

const truthPath = fileURLToPath(new URL("./fixtures/ephemeris_truth.json", import.meta.url));
const LIMIT_DEG = 0.01;

interface Truth {
  frame: string;
  kernels: string[];
  sites: { id: string; lat: number; lon: number }[];
  t0_unix_s: number;
  step_s: number;
  rows: number[][];
  sub_points: number[][];
}

describe.skipIf(!existsSync(truthPath))("ephemeris against SPICE", () => {
  it(`Sun and Earth elevation and azimuth agree within ${LIMIT_DEG} deg at every site and epoch`, () => {
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
    const stats = truth.sites.map(() => ({ sq: [0, 0, 0, 0], max: [0, 0, 0, 0] }));
    const bases = truth.sites.map((s) => siteBasis(s.lat, s.lon, 0));
    // Azimuth error is measured on the sky (scaled by cos elevation) so it is comparable with elevation error.
    const azErr = (a: number, b: number, el: number) => {
      let d = Math.abs(a - b);
      if (d > 180) d = 360 - d;
      return d * Math.cos((el * Math.PI) / 180);
    };
    let subMax = 0;
    truth.rows.forEach((row, i) => {
      const state = bodyFixed((truth.t0_unix_s + i * truth.step_s) * 1000);
      truth.sites.forEach((_, k) => {
        const sky = skyAt(bases[k], state);
        const r = row.slice(k * 4, k * 4 + 4);
        const errs = [
          Math.abs(sky.sun.elevationDeg - r[0]),
          azErr(sky.sun.azimuthDeg, r[1], r[0]),
          Math.abs(sky.earth.elevationDeg - r[2]),
          azErr(sky.earth.azimuthDeg, r[3], r[2]),
        ];
        errs.forEach((e, j) => {
          stats[k].sq[j] += e * e;
          stats[k].max[j] = Math.max(stats[k].max[j], e);
        });
      });
      const sp = truth.sub_points[i];
      const ss = subPoint(state.sun);
      const se = subPoint(state.earth);
      subMax = Math.max(subMax, Math.abs(ss.latDeg - sp[0]), Math.abs(se.latDeg - sp[3]), Math.abs(se.lonDeg - sp[4]));
    });
    const n = truth.rows.length;
    const lines = [
      `${n} epochs x ${truth.sites.length} sites, frame ${truth.frame}, kernels ${truth.kernels.join(", ")}`,
      "site               sunEl rms/max      sunAz rms/max      earthEl rms/max    earthAz rms/max   (deg, azimuth on-sky)",
    ];
    stats.forEach((s, k) => {
      const cols = s.sq.map((q, j) => `${Math.sqrt(q / n).toFixed(4)}/${s.max[j].toFixed(4)}`.padEnd(18));
      lines.push(`${truth.sites[k].id.padEnd(18)} ${cols.join(" ")}`);
    });
    const worst = Math.max(...stats.flatMap((s) => s.max));
    lines.push(`largest error ${worst.toFixed(4)} deg (limit ${LIMIT_DEG}); sub-point lat/lon largest error ${subMax.toFixed(4)} deg`);
    console.log(lines.join("\n"));
    expect(worst).toBeLessThan(LIMIT_DEG);
  });
});
