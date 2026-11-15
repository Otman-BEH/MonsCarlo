/* Dump parity fixtures from main's JS engine for the Python port.
   Run from the repo root after `npm ci`:   node backend/tools/make_golden.js
   Writes backend/tests/fixtures/golden.json. Loads src/ exactly as build/test_core.js does. */
global.Eng = require('../../src/engine.js'); global.Terrain = require('../../src/terrain.js');
const Ana = require('../../src/analysis.js'), data = require('../../build/data.json'), fs = require('fs'), path = require('path');
const arr = a => Array.from(a, v => (Number.isFinite(v) ? v : (v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN')));

(async () => {
  await Terrain.load(data);
  const out = { arch: process.arch, node: process.version };
  // 1. Hourly ephemeris table: 40 days from 2026-12-01T00:00Z, raw Moon-fixed vectors [sx,sy,sz,ex,ey,ez] (km)
  const T0 = Date.UTC(2026, 11, 1), N = 40 * 24, tab = Eng.makeTable(T0, 3600e3, N);
  out.table = { t0_ms: T0, step_ms: 3600e3, n: N, a: arr(tab.a) };

  // 2. Skylines: 80 m profiles (curated sites) and in-browser ray casts (custom points, no fine patch focus)
  const ids = ['shack', 'ridge', 'gerl', 'ce7', 'mala', 'viper', 'im2', 'im1', 'pole'];
  out.sites = {}; for (const id of ids) { const q = Terrain.profiles.sites[id]; out.sites[id] = { lat: q.lat, lon: q.lon, h0: q.h0 }; }
  out.profileMask = {};
  for (const id of ids) { out.profileMask[id] = {}; for (const e of [0, 2, 5, 10]) { const m = Terrain.profileMask(id, e); out.profileMask[id][e] = { h0: m.h0, mask: arr(m.mask) }; } }
  Terrain.setFocus(-70, 0);                 // no fine patch
  out.horizonMask = [];
  for (const [lat, lon] of [[-89.5, 30], [-45, 30], [0.5, 23]]) { const m = Terrain.horizonMask(lat, lon, 2, 360); out.horizonMask.push({ lat, lon, eye: 2, naz: 360, h0: m.h0, tier: m.tier, mask: arr(m.mask) }); }
  out.elev = [[-89.67, 129.2], [0.6741, 23.473], [5.44, -158.69], [-85, 180], [-79.5, 40], [-60, -10], [80, 5]].map(([lat, lon]) => ({ lat, lon, h: Terrain.elev(lat, lon) }));

  // 3. Series for three sites over the same table (eye 2 m)
  out.series = {};
  for (const id of ['shack', 'mala', 'im2']) {
    const q = Terrain.profiles.sites[id], m = Terrain.profileMask(id, 2), se = Ana.seriesAt({ id, lat: q.lat, lon: q.lon }, 2, m, tab, 0, N);
    out.series[id] = {}; for (const k of ['sunEl', 'sunAz', 'sunClr', 'sunFrac', 'earthEl', 'earthAz', 'earthClr', 'irr', 'sunRad']) out.series[id][k] = arr(se[k]);
    out.series[id].stats = Ana.stats(se, 0, 30 * 24, 1, true);
  }

  // 4. Mission and verdict for several configs on the Shackleton and Malapert series
  const base = { days: 10, peakW: 400, loadSun: 180, loadDark: 60, capWh: 2000, minSoc: 0.2, tracking: true, needEarth: true, maxGapH: 12, margin: 0.3, chargeEff: 0.9, fault: { kind: 'none', day: 3 }, safe: false, autonomyH: 6 };
  const cfgs = [
    ['reference', {}], ['horizontal', { tracking: false }], ['array_fault', { fault: { kind: 'array', day: 3 } }],
    ['battery_fault', { fault: { kind: 'battery', day: 2 } }], ['load_fault_safe', { fault: { kind: 'load', day: 1 }, safe: true, capWh: 1500 }],
    ['antenna_fault', { fault: { kind: 'antenna', day: 4 } }], ['small_battery', { capWh: 600, maxGapH: 48 }], ['relay', { needEarth: false, capWh: 900 }],
  ];
  out.mission = [];
  for (const id of ['shack', 'mala']) {
    const q = Terrain.profiles.sites[id], se = Ana.seriesAt({ id, lat: q.lat, lon: q.lon }, 2, Terrain.profileMask(id, 2), tab, 0, N);
    for (const i0 of [0, 100, 333]) for (const [name, over] of cfgs) {
      const cfg = Object.assign({}, base, over), r = Ana.mission(se, i0, cfg, 0, true), rm = Ana.mission(se, i0, cfg, cfg.margin, false), v = Ana.verdict(se, i0, cfg);
      const pick = x => ({ ok: x.ok, fails: x.fails, minSoc: x.minSoc, kMin: x.kMin, kFail: x.kFail, maxGapH: x.maxGapH, maxDarkH: x.maxDarkH, linkPct: x.linkPct, litPct: x.litPct, battNeedWh: Number.isFinite(x.battNeedWh) ? x.battNeedWh : 'Infinity', n: x.n, safeH: x.safeH, faultK: x.faultK });
      out.mission.push({ site: id, i0, name, cfg, nominal: Object.assign(pick(r), { soc: arr(r.soc) }), margin: pick(rm), verdict: v.state });
    }
  }

  // 5. Random numbers and Monte Carlo pieces
  out.rng = [1, 42, 20261114].map(seed => { const R = Ana.rng(seed), u = [], n = []; for (let i = 0; i < 20; i++) u.push(R.u()); const R2 = Ana.rng(seed); for (let i = 0; i < 20; i++) n.push(R2.n()); return { seed, u, n }; });
  out.mix = [[20261114, 0, 0], [20261114, 0, 1], [20261114, 112, 0], [20261114, 224, 1], [1, 5, 0], [7, 3, 0], [7, 3, 1], [4294967295, 9, 1], [0, 0, 0], [123456789, 77, 0]].map(([s, k, salt]) => ({ seed: s, k, salt, h: Ana.mix(s, k, salt) }));
  {
    const q = Terrain.profiles.sites.mala, se = Ana.seriesAt({ id: 'mala', lat: q.lat, lon: q.lon }, 2, Terrain.profileMask('mala', 2), tab, 0, N);
    const sig = { timeH: 2, terrainDeg: 0.15, power: 0.05, load: 0.05, cap: 0.03, corr: false };
    out.cellTrials = [];
    for (const [i0, corr, seed] of [[100, false, 20261114], [333, true, 99], [5, false, 7]]) {
      const s = Object.assign({}, sig, { corr }), counts = new Uint16Array(6), p = Ana.cellTrials(se, i0, base, s, Ana.rng(Ana.mix(seed, 3, 0)), 48, counts);
      out.cellTrials.push({ site: 'mala', i0, cfg: base, sig: s, seed: Ana.mix(seed, 3, 0), K: 48, p, counts: Array.from(counts) });
    }
  }
  { const n = 9, P = new Float32Array(n * n); for (let i = 0; i < n * n; i++) P[i] = ((i * 37) % 11) / 10;
    out.aimStats = { n, P: arr(P), cases: [[4, 4, 0.1, 0.1, 24], [1, 4, 0.1, 0.1, 24], [6, 2, 0.12, 0.2, 48]].map(([ax, ay, s, sg, K]) => ({ ax, ay, s, sigma: sg, K, r: Ana.aimStats(P, n, s, ax, ay, sg, K), prob: Ana.aimProb(P, n, s, ax, ay, sg) })) };
    out.wilson = [[0.5, 100], [0, 50], [0.93, 12.5], [1, 30]].map(([p, n]) => ({ p, n, ci: Ana.wilson(p, n) })); }
  { const L = []; let a = 12345; const u = () => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 4294967296; };
    for (let i = 0; i < 4000; i++) { const x = Math.pow(u() + 1e-12, 1 + u() * 20); L.push([x, Math.log(x)]); } out.logs = L; }
  // 6. Design lab (inverse design) and the Deep Space Network view, on the Malapert series
  {
    const q = Terrain.profiles.sites.mala, se = Ana.seriesAt({ id: 'mala', lat: q.lat, lon: q.lon }, 2, Terrain.profileMask('mala', 2), tab, 0, N);
    const massOf = { wkg: 80, whkg: 160 };
    out.design = [];
    for (const [i0, over] of [[100, {}], [333, { tracking: false }], [520, { fault: { kind: 'load', day: 2 }, safe: true }]]) {
      const cfg = Object.assign({}, base, over), F = Ana.designFrontier(se, i0, cfg, massOf, 36, 12, true);
      const pa = Ana.minArray(se, i0, cfg, cfg.capWh, true, F.pMax, 14);
      const cb = Ana.bisectUp(c => Ana.mission(se, i0, Object.assign({}, cfg, { capWh: c }), cfg.margin, false).ok, 10, 60000, 16);
      const atlas = []; for (let j = 0; j < 20; j++) { const i = i0 + j * 12; if (i + cfg.days * 24 > N) break; const G = Ana.designFrontier(se, i, cfg, massOf, 12, 9, false); atlas.push(G.best ? [G.best.peakW, G.best.capWh, G.best.mass] : null); }
      out.design.push({ site: 'mala', i0, cfg, caps: F.caps, rob: F.rob, nom: F.nom, best: F.best, pMax: F.pMax, minArrayAtCap: pa, minBatteryAtArray: cb, atlas });
    }
    out.dsn = [0, 7, 19, 33.5, 101].map(hh => ({ ms: T0 + hh * 3600e3, v: Eng.dsnView(T0 + hh * 3600e3) }));
  }
  out.nextCross = [[[-2, -1, 1, 3], 0], [[1, 2, 3], 0], [[3, 1, -1, -2, 2], 0.5]].map(([a, x]) => ({ a, x, r: Ana.nextCross(Float32Array.from(a), x, a.length) }));

  const dir = path.join(__dirname, '..', 'tests', 'fixtures'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'golden.json'), JSON.stringify(out));
  console.log('wrote', path.join(dir, 'golden.json'), (JSON.stringify(out).length / 1e6).toFixed(1), 'MB');
})().catch(e => { console.error(e); process.exit(1); });
