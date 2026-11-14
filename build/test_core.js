// Unit tests for geometry, terrain and the mission model. Run with: npm test
global.Eng = require('../src/engine.js'); global.Terrain = require('../src/terrain.js');
const Ana = require('../src/analysis.js'), data = require('./data.json'), assert = require('assert');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, m + ' (got ' + a + ', want ' + b + ')');
(async () => {
  await Terrain.load(data);
  // solar disc fraction
  near(Eng.discFrac(1, 0.266, 0), 1, 0, 'disc fully above'); near(Eng.discFrac(-1, 0.266, 0), 0, 0, 'disc fully below'); near(Eng.discFrac(0.5, 0.266, 0.5), 0.5, 1e-9, 'disc half above');
  ok(Eng.discFrac(0.1, 0.266, 0) > 0.5 && Eng.discFrac(0.1, 0.266, 0) < 1, 'disc partly above');
  // sub-Earth point stays near the centre of the near side (libration is under 8.2 deg)
  for (let k = 0; k < 400; k++) { const p = Eng.subPoint(Eng.bodyFixed(Date.UTC(2026, 10, 14) + k * 86400e3 * 1.37).earth); ok(Math.abs(p.lat) < 7 && Math.abs(p.lon) < 8.3, 'libration bounds'); }
  // sub-solar latitude stays within the lunar axial tilt
  for (let k = 0; k < 400; k++) { const p = Eng.subPoint(Eng.bodyFixed(Date.UTC(2026, 10, 14) + k * 86400e3 * 1.37).sun); ok(Math.abs(p.lat) < 1.62, 'sub-solar latitude within 1.6 deg'); }
  // geometry: a body straight above the site has elevation 90; on the horizon plane, 0
  const b = Eng.siteBasis(-45, 30, 0); near(Eng.look(b, b.up.map(v => v * 4e5), 1).el, 90, 1e-6, 'zenith');
  near(Eng.look(b, b.north.map((v, i) => v * 1e9 + b.up[i] * b.r), 1).el, 0, 1e-6, 'horizon'); near(Eng.look(b, b.east.map((v, i) => v * 1e9 + b.up[i] * b.r), 1).az, 90, 1e-6, 'east azimuth');
  // terrain: known elevations (m above the 1737.4 km sphere)
  near(Terrain.elev(-89.67, 129.2), -2787, 120, 'Shackleton floor'); near(Terrain.elev(0.6741, 23.473), -1918, 60, 'Apollo 11'); near(Terrain.elev(5.44, -158.69), 10200, 600, 'highest point, 1/4 degree grid');
  ok(isFinite(Terrain.elev(-90, 0)) && isFinite(Terrain.elev(90, 0)) && isFinite(Terrain.elev(-80.02, 179.99)) && isFinite(Terrain.elev(-80.0, -180)), 'poles and seams are finite');
  near(Terrain.elev(-85, 180), Terrain.elev(-85, -180), 1e-6, 'longitude wrap, polar raster'); near(Terrain.elev(10, 180), Terrain.elev(10, -180), 1e-6, 'longitude wrap, global grid');
  // horizon masks: a summit sees a depressed horizon; a crater floor sees a raised one
  const ridge = Ana.siteMask({ id: 'ridge', lat: Terrain.profiles.sites.ridge.lat, lon: Terrain.profiles.sites.ridge.lon }, 2);
  ok(ridge.tier === 'LOLA 80 m' && ridge.hi < 0, 'connecting ridge summit horizon is below level');
  const floor = Ana.siteMask({ lat: -89.67, lon: 129.2 }, 2); ok(floor.tier === 'LOLA 400 m' && floor.lo > 5, 'Shackleton floor is walled in');
  const hi = Ana.siteMask({ id: 'shack', lat: 0, lon: 0 }, 100), lo = Ana.siteMask({ id: 'shack', lat: 0, lon: 0 }, 0); ok(hi.hi <= lo.hi + 1e-6, 'a taller mast never raises the horizon');
  // 400 m in-browser ray cast agrees with the 80 m profile at an open site (IM-2) to within a degree
  const q = Terrain.profiles.sites.im2, m80 = Ana.siteMask({ id: 'im2', lat: q.lat, lon: q.lon }, 2).mask, m400 = Ana.siteMask({ lat: q.lat, lon: q.lon }, 2).mask;
  let d = 0; for (let a = 0; a < 360; a++) d += Math.abs(Terrain.maskAt(m80, a) - Terrain.maskAt(m400, a)); near(d / 360, 0, 1.0, 'mean 80 m vs 400 m horizon difference');
  // the pole preset is evaluated without NaN
  const tab = Eng.makeTable(Date.UTC(2026, 10, 14), 3600e3, 60 * 24), pole = Ana.series({ id: 'pole', lat: -90, lon: 0 }, 2, tab); ok(pole.sunClr.every(isFinite) && pole.earthClr.every(isFinite), 'pole series finite');
  // zero-crossing search
  const c = Ana.nextCross(Float32Array.from([-2, -1, 1, 3]), 0, 4); near(c.idx, 1.5, 1e-9, 'crossing index'); ok(c.rising, 'crossing direction'); ok(Ana.nextCross(Float32Array.from([1, 2, 3]), 0, 3) === null, 'no crossing');
  // mission model on synthetic series
  const N = 48, mk = (clr, e) => ({ n: N, sunClr: Float32Array.from({ length: N }, (_, i) => clr(i)), earthClr: Float32Array.from({ length: N }, (_, i) => e(i)), sunEl: new Float32Array(N).fill(30), irr: new Float32Array(N).fill(1) });
  const cfg = { days: 2, peakW: 400, loadSun: 100, loadDark: 50, capWh: 1000, minSoc: 0.2, tracking: true, needEarth: true, maxGapH: 6, margin: 0.3, chargeEff: 0.9 };
  let r = Ana.mission(mk(() => 5, () => 5), 0, cfg, 0, true); ok(r.ok && r.minSoc === 1 && r.maxGapH === 0 && r.battNeedWh === 0, 'always lit and linked passes');
  r = Ana.mission(mk(i => i < 24 ? 5 : -5, () => 5), 0, cfg, 0, false); near(r.minSoc, 0, 1e-9, '24 h of darkness at 50 W empties a 1000 Wh battery'); ok(!r.ok && /battery/.test(r.fails.join()), 'battery failure reported');
  r = Ana.mission(mk(i => i < 24 ? 5 : -5, () => 5), 0, Object.assign({}, cfg, { capWh: 2000 }), 0, false); near(r.minSoc, 0.4, 1e-6, '2000 Wh leaves 40%'); ok(r.ok, 'bigger battery passes'); near(r.battNeedWh, 1200 / 0.8, 1e-6, 'battery needed');
  r = Ana.mission(mk(() => 5, i => i >= 10 && i < 20 ? -1 : 5), 0, cfg, 0, false); ok(!r.ok && r.maxGapH === 10, '10 h link gap breaks a 6 h limit'); ok(Ana.mission(mk(() => 5, i => i >= 10 && i < 20 ? -1 : 5), 0, Object.assign({}, cfg, { needEarth: false }), 0, false).ok, 'relay mission ignores the gap');
  ok(!Ana.mission(mk(() => -5, () => 5), 0, cfg, 0, false).ok, 'landing in darkness fails');
  ok(Ana.verdict(mk(() => 0.2, () => 5), 0, cfg).state === 1, 'a pass that depends on 0.2 deg of clearance is marginal with a 0.3 deg margin'); ok(Ana.verdict(mk(() => 2, () => 5), 0, cfg).state === 2, 'robust pass');
  ok(!Ana.mission(mk(() => 5, () => 5), 40, cfg, 0, false).ok, 'a mission that runs past the table end is not passed');
  // Monte Carlo pieces
  const R1 = Ana.rng(42), R2 = Ana.rng(42); ok(R1.u() === R2.u() && R1.n() === R2.n(), 'same seed gives the same random numbers');
  let sm = 0, sq = 0; const RN = Ana.rng(7); for (let i = 0; i < 50000; i++) { const v = RN.n(); sm += v; sq += v * v; } near(sm / 50000, 0, 0.02, 'normal mean'); near(sq / 50000, 1, 0.03, 'normal variance');
  const sig0 = { timeH: 0, terrainDeg: 0, power: 0, load: 0, cap: 0 }, sig1 = { timeH: 1, terrainDeg: 0.15, power: 0.05, load: 0.05, cap: 0.03 };
  let cnt = new Uint16Array(6); near(Ana.cellTrials(mk(() => 5, () => 5), 0, cfg, sig1, Ana.rng(1), 200, cnt), 1, 0, 'a site with wide margins always succeeds'); ok(cnt.every(v => v === 0), 'no failure causes recorded');
  cnt = new Uint16Array(6); near(Ana.cellTrials(mk(() => -5, () => 5), 0, cfg, sig1, Ana.rng(1), 200, cnt), 0, 0, 'a dark site always fails'); ok(cnt[0] === 200, 'cause is darkness at landing');
  cnt = new Uint16Array(6); const pm = Ana.cellTrials(mk(() => 5, () => 0.0), 0, cfg, { timeH: 0, terrainDeg: 0.15, power: 0, load: 0, cap: 0 }, Ana.rng(3), 4000, cnt); near(pm, 0.5, 0.04, 'zero Earth clearance with symmetric terrain error succeeds about half the time'); ok(cnt[1] > 1500, 'cause is Earth at landing');
  near(Ana.cellTrials(mk(() => 5, () => 5), 0, cfg, sig0, Ana.rng(1), 10, new Uint16Array(6)), 1, 0, 'no spread reproduces the deterministic pass');
  const PU = new Float32Array(81).fill(0.7); near(Ana.aimProb(PU, 9, 0.1, 4, 4, 0.1).p, 0.7, 1e-6, 'uniform success map gives the same chance anywhere');
  const PH = new Float32Array(81); for (let y = 0; y < 9; y++) for (let x = 5; x < 9; x++) PH[y * 9 + x] = 1;
  ok(Ana.aimProb(PH, 9, 0.1, 7, 4, 0.1).p > Ana.aimProb(PH, 9, 0.1, 4, 4, 0.1).p && Ana.aimProb(PH, 9, 0.1, 4, 4, 0.1).p > Ana.aimProb(PH, 9, 0.1, 1, 4, 0.1).p, 'aiming deeper into the good region raises the chance');
  near(Ana.aimProb(PH, 9, 0.1, 4, 4, 0.01).p, 0, 1e-6, 'a perfect lander aimed at a bad cell fails'); near(Ana.aimProb(PH, 9, 0.1, 6, 4, 0.01).p, 1, 1e-6, 'a perfect lander aimed at a good cell succeeds');
  ok(Terrain.horizonMask(-89.5, 30, 2, 180).mask.length === 180, 'coarser azimuth sampling for the risk grid');
  // fine patches
  { const q2 = Terrain.profiles.sites.ridge; Terrain.setFocus(-70, 0); const coarse = Ana.siteMask({ lat: q2.lat, lon: q2.lon + 1e-7 }, 2).mask; ok(Terrain.setFocus(q2.lat, q2.lon) !== null, 'a patch is found for a listed site');
    const fine = Terrain.horizonMask(q2.lat, q2.lon, 2, 360), ref = Terrain.profileMask('ridge', 2).mask; let dc = 0, df = 0; for (let a = 0; a < 360; a++) { dc += Math.abs(Terrain.maskAt(ref, a) - coarse[a]); df += Math.abs(Terrain.maskAt(ref, a) - fine.mask[a]); }
    ok(df / 360 < 0.15 && df < dc, 'with the fine patch the browser ray cast is within 0.15 deg of the 80 m reference (' + (df / 360).toFixed(2) + ' vs ' + (dc / 360).toFixed(2) + ')'); near(fine.h0, q2.h0, 3, 'site height from the patch matches the 80 m model');
    const rho = 2 * 1737.4 * Math.tan((90 + q2.lat) / 2 * Math.PI / 180), x = rho * Math.sin(q2.lon * Math.PI / 180), y = rho * Math.cos(q2.lon * Math.PI / 180);
    near(Terrain.elevXYsmooth(x + 0.5, y - 0.3), Terrain.elevXY(x + 0.5, y - 0.3), 25, 'smooth and bilinear sampling agree closely'); ok(Terrain.setFocus(-70, 0) === null, 'no patch away from the pole'); Terrain.setFocus(-70, 0); }
  // stress test and safe mode
  { const dark24 = mk(i => i < 12 || i >= 36 ? 5 : -5, () => 5), c2 = Object.assign({}, cfg, { capWh: 3000 });
    ok(Ana.mission(dark24, 0, c2, 0, false).ok, 'baseline survives a 24 h night on 3000 Wh');
    const f = Object.assign({}, c2, { fault: { kind: 'battery', day: 0.25 } }); ok(Ana.mission(dark24, 0, f, 0, false).minSoc < Ana.mission(dark24, 0, c2, 0, false).minSoc, 'losing battery capacity lowers the minimum charge');
    const fl = Object.assign({}, cfg, { capWh: 2600, fault: { kind: 'load', day: 0 } }), a = Ana.mission(dark24, 0, fl, 0, true), b = Ana.mission(dark24, 0, Object.assign({}, fl, { safe: true }), 0, true);
    ok(b.minSoc >= a.minSoc && b.safeH >= 0 && b.safeArr.length === 48, 'safe mode never makes the battery worse'); ok(Ana.mission(dark24, 0, Object.assign({}, cfg, { fault: { kind: 'none', day: 1 } }), 0, false).faultK === -1, 'no fault, no fault marker');
    const arr = Ana.mission(mk(() => 5, () => 5), 0, Object.assign({}, cfg, { peakW: 120, fault: { kind: 'array', day: 1 } }), 0, true); ok(arr.soc[24] === 1 && arr.soc[47] < 1, 'array fault only bites after its start day');
    const ant = Ana.mission(mk(() => 5, () => 5), 0, Object.assign({}, cfg, { fault: { kind: 'antenna', day: 0.5 } }), 0, false); ok(ant.maxGapH === 24 && !ant.ok, 'a 24 h antenna outage breaks a 6 h gap limit'); }
  // Monte Carlo statistics
  { const w = Ana.wilson(0.5, 100); near(w[0], 0.404, 0.002, 'Wilson lower bound'); near(w[1], 0.596, 0.002, 'Wilson upper bound'); const w0 = Ana.wilson(0, 50); ok(w0[0] === 0 && w0[1] > 0 && w0[1] < 0.1, 'Wilson interval at zero successes is not empty');
    const st = Ana.aimStats(new Float32Array(81).fill(0.5), 9, 0.1, 4, 4, 0.1, 24); near(st.p, 0.5, 1e-9, 'aimStats share'); ok(st.lo < 0.5 && st.hi > 0.5 && st.hi - st.lo < 0.2 && st.inside, 'aimStats interval brackets the share');
    ok(!Ana.aimStats(new Float32Array(81).fill(0.5), 9, 0.1, 1, 4, 0.1, 24).inside, 'an aim point whose landing circle leaves the map is flagged');
    const many = Ana.aimStats(new Float32Array(81).fill(0.5), 9, 0.1, 4, 4, 0.1, 2400); ok(many.hi - many.lo < st.hi - st.lo, 'more trials give a narrower interval');
    const cc = new Uint16Array(6), ind = Ana.cellTrials(mk(i => i < 20 ? 5 : -5, () => 5), 0, Object.assign({}, cfg, { capWh: 1900 }), { timeH: 0, terrainDeg: 0, power: 0, load: 0.08, cap: 0.08, corr: false }, Ana.rng(5), 3000, cc), cor = Ana.cellTrials(mk(i => i < 20 ? 5 : -5, () => 5), 0, Object.assign({}, cfg, { capWh: 1900 }), { timeH: 0, terrainDeg: 0, power: 0, load: 0.08, cap: 0.08, corr: true }, Ana.rng(5), 3000, cc);
    ok(ind > 0.02 && ind < 0.98 && cor > 0.02 && cor < 0.98 && Math.abs(ind - cor) < 0.2, 'independent and linked hardware errors both give a mixed outcome (' + ind.toFixed(2) + ', ' + cor.toFixed(2) + ')'); }
  // emergency autonomy and inverse design
  { const sunny = mk(() => 5, () => 5), tiny = Object.assign({}, cfg, { capWh: 100 });
    ok(Ana.mission(sunny, 0, tiny, 0, false).ok, 'without an autonomy rule a tiny battery passes in continuous sunlight'); const au = Ana.mission(sunny, 0, Object.assign({}, tiny, { autonomyH: 6 }), 0, false);
    ok(!au.ok && /blackout/.test(au.fails.join()), 'a 6 h blackout rule rejects the tiny battery'); ok(Ana.mission(sunny, 0, Object.assign({}, cfg, { capWh: 400, autonomyH: 6 }), 0, false).ok, '400 Wh covers 6 h at 50 W above a 20% reserve'); near(au.battNeedWh, 300 / 0.8, 1e-6, 'battery needed includes the blackout energy');
    near(Ana.bisectUp(x => x >= 37, 0, 100, 20), 37, 1e-3, 'bisection finds the threshold'); ok(Ana.bisectUp(x => false, 0, 100) === null && Ana.bisectUp(x => true, 5, 100) === 5, 'bisection edge cases');
    const c6 = Object.assign({}, cfg, { autonomyH: 6 }), pa = Ana.minArray(sunny, 0, c6, 1000, true, 3000, 14); near(pa, 89.6, 1, 'smallest array: a 1000 Wh battery may give up 500 Wh over 48 h, so 89.6 W covers a 100 W load');
    const night = mk(i => i < 12 || i >= 36 ? 5 : -5, () => 5), F = Ana.designFrontier(night, 0, c6, { wkg: 80, whkg: 160 }, 30, 12, true);
    ok(F.best && Ana.mission(night, 0, Object.assign({}, c6, F.best), cfg.margin, false).ok, 'the lightest design passes the full simulation with the terrain margin');
    ok(!Ana.mission(night, 0, Object.assign({}, c6, { peakW: F.best.peakW * 0.8, capWh: F.best.capWh * 0.8 }), cfg.margin, false).ok, 'a design 20% smaller on both axes fails');
    let mono = true, lastP = Infinity; F.rob.forEach(v => { if (v !== null) { if (v > lastP + 1) mono = false; lastP = v; } }); ok(mono, 'a bigger battery never needs a bigger array'); ok(F.nom.every((v, k) => v === null || F.rob[k] === null || v <= F.rob[k] + 1), 'the nominal frontier never lies above the robust one');
    ok(Ana.designFrontier(mk(() => -5, () => 5), 0, c6, { wkg: 80, whkg: 160 }, 10, 8, false).best === null, 'no hardware fixes a landing in darkness'); }
  // review fixes: battery needed under a battery fault, and invalid inputs
  { const night = mk(i => i < 12 || i >= 36 ? 5 : -5, () => 5), fc = Object.assign({}, cfg, { fault: { kind: 'battery', day: 0.5 } }), r = Ana.mission(night, 0, fc, 0, false);
    near(r.battNeedWh, 1200 / 0.55, 1e-6, 'with a battery fault, battery needed allows for the lost quarter of the capacity');
    ok(Ana.mission(night, 0, Object.assign({}, fc, { capWh: r.battNeedWh * 1.01 }), 0, false).ok, 'a battery of the size reported as needed survives the battery fault');
    ok(Ana.mission(night, 0, Object.assign({}, fc, { minSoc: 0.8 }), 0, false).battNeedWh === Infinity, 'no battery size is enough when the reserve is above what a faulted battery can hold');
    ok(!Ana.mission(night, 0, Object.assign({}, cfg, { peakW: NaN }), 0, false).ok, 'a mission with an invalid number does not pass'); }
  // per-cell random streams and the Sun's apparent size
  { ok(Ana.mix(7, 3, 0) === Ana.mix(7, 3, 0) && Ana.mix(7, 3, 0) !== Ana.mix(7, 3, 1) && Ana.mix(7, 3, 0) !== Ana.mix(7, 4, 0) && Ana.mix(7, 3, 0) !== Ana.mix(8, 3, 0), 'stream seeds repeat and differ by seed, cell and half');
    const a = Ana.rng(Ana.mix(7, 3, 0)), b = Ana.rng(Ana.mix(7, 3, 0)); ok(a.n() === b.n() && a.u() === b.u(), 'the same stream seed gives the same draws');
    const half = { sunClr: Float32Array.of(0.13), sunRad: Float32Array.of(0.26) }; near(Ana.fracAt(half, 0, 0), 1 - (Math.acos(0.5) - 0.5 * Math.sqrt(0.75)) / Math.PI, 1e-6, 'the solar disc uses the apparent radius stored in the series');
    ok(Ana.fracAt({ sunClr: Float32Array.of(0.13) }, 0, 0) < Ana.fracAt(half, 0, 0), 'without a stored radius the mean 0.266 degrees is used');
    const sr = Ana.seriesAt({ lat: -85, lon: 10 }, 2, { mask: new Float32Array(360), h0: 0 }, Eng.makeTable(Date.UTC(2027, 0, 1), 3600e3, 4), 0, 4); ok(sr.sunRad.length === 4 && sr.sunRad[0] > 0.26 && sr.sunRad[0] < 0.275, 'a computed series carries the Sun\'s apparent radius (' + sr.sunRad[0].toFixed(4) + ' deg)'); }
  console.log(n + ' checks passed');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
