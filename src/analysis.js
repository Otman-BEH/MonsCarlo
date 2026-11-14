/* Per-site time series and window statistics on top of Eng + Terrain. */
const Ana = (() => {
  const E = (typeof Eng !== 'undefined') ? Eng : require('./engine.js');
  const T = (typeof Terrain !== 'undefined') ? Terrain : require('./terrain.js');
  const maskCache = new Map();
  function siteMask(site, eye) {
    const k = (site.id || '') + ',' + site.lat.toFixed(4) + ',' + site.lon.toFixed(4) + ',' + eye;
    let m = maskCache.get(k);
    if (!m) {
      m = (site.id && T.profileMask(site.id, eye)) || T.horizonMask(site.lat, site.lon, eye);
      let lo = 99, hi = -99; for (const v of m.mask) { if (v < lo) lo = v; if (v > hi) hi = v; } m.lo = lo; m.hi = hi;
      if (maskCache.size > 80) maskCache.clear(); maskCache.set(k, m);
    }
    return m;
  }
  // Sun and Earth state at one instant from precomputed body-fixed vectors.
  function stateFrom(site, eye, sun, earth) { return stateWith(site, eye, siteMask(site, eye), sun, earth); }
  // Same, with the horizon mask supplied by the caller.
  function stateWith(site, eye, m, sun, earth) {
    const lat = Math.max(-89.999, Math.min(89.999, site.lat));
    const b = E.siteBasis(lat, site.lon, (m.h0 + eye) / 1000);
    const s = E.look(b, sun, E.RSUN), e = E.look(b, earth, E.REARTH);
    const hs = T.maskAt(m.mask, s.az), he = T.maskAt(m.mask, e.az);
    return { sunEl: s.el, sunAz: s.az, sunRad: s.rad, sunHz: hs, sunClr: s.el - hs, sunFrac: E.discFrac(s.el, s.rad, hs),
             earthEl: e.el, earthAz: e.az, earthRad: e.rad, earthHz: he, earthClr: e.el - he, h0: m.h0, irr: (149597870.7 / s.dist) * (149597870.7 / s.dist) };
  }
  function series(site, eye, tab) { return seriesAt(site, eye, siteMask(site, eye), tab, 0, tab.n); }
  // Series for samples [start, start + n) of a table, with a caller-supplied horizon mask.
  function seriesAt(site, eye, m, tab, start, n) {
    const a = tab.a.subarray(start * 6, (start + n) * 6);
    const o = { n, sunEl: new Float32Array(n), sunAz: new Float32Array(n), sunClr: new Float32Array(n), sunFrac: new Float32Array(n),
                earthEl: new Float32Array(n), earthAz: new Float32Array(n), earthClr: new Float32Array(n), irr: new Float32Array(n), sunRad: new Float32Array(n) };
    const sv = [0, 0, 0], ev = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      sv[0] = a[i*6]; sv[1] = a[i*6+1]; sv[2] = a[i*6+2]; ev[0] = a[i*6+3]; ev[1] = a[i*6+4]; ev[2] = a[i*6+5];
      const s = stateWith(site, eye, m, sv, ev);
      o.sunEl[i] = s.sunEl; o.sunAz[i] = s.sunAz; o.sunClr[i] = s.sunClr; o.sunFrac[i] = s.sunFrac;
      o.earthEl[i] = s.earthEl; o.earthAz[i] = s.earthAz; o.earthClr[i] = s.earthClr; o.irr[i] = s.irr; o.sunRad[i] = s.sunRad;
    }
    return o;
  }
  // Next zero crossing of arr after fractional index x; returns {idx, rising} or null.
  function nextCross(arr, x, n) {
    let i = Math.floor(x); if (i < 0) i = 0;
    const f = x - i;
    let prev = (i + 1 < n) ? arr[i] * (1 - f) + arr[i + 1] * f : arr[Math.min(i, n - 1)];
    let px = x;
    for (let j = i + 1; j < n; j++) {
      const v = arr[j];
      if ((prev > 0) !== (v > 0)) return { idx: px + (j - px) * (prev / (prev - v)), rising: v > 0 };
      prev = v; px = j;
    }
    return null;
  }
  // Statistics over samples [i0, i1).
  function stats(se, i0, i1, stepH, needEarth) {
    let lit = 0, link = 0, both = 0, pTrack = 0, pFlat = 0, runL = 0, maxL = 0, runD = 0, maxD = 0, runO = 0, maxO = 0, runB = 0, maxB = 0;
    const n = i1 - i0;
    for (let i = i0; i < i1; i++) {
      const L = se.sunClr[i] > 0, K = se.earthClr[i] > 0, B = L && (K || !needEarth);
      if (L) { lit++; runL++; if (runL > maxL) maxL = runL; runD = 0; } else { runD++; if (runD > maxD) maxD = runD; runL = 0; }
      if (K) { link++; runO = 0; } else { runO++; if (runO > maxO) maxO = runO; }
      if (B) { both++; runB++; if (runB > maxB) maxB = runB; } else runB = 0;
      pTrack += se.sunFrac[i];
      pFlat += se.sunFrac[i] * Math.max(0, Math.sin(se.sunEl[i] * Math.PI / 180));
    }
    const d = stepH / 24;
    return { litPct: 100 * lit / n, linkPct: 100 * link / n, bothPct: 100 * both / n, pTrack: 100 * pTrack / n, pFlat: 100 * pFlat / n,
             maxLitD: maxL * d, maxDarkD: maxD * d, maxOutD: maxO * d, maxBothD: maxB * d };
  }
  // Mission simulation from sample i0 (1 h steps). margin (deg) raises the terrain horizon for both Sun and Earth.
  const SUNR = 0.266;
  // The solar disc uses the Sun's apparent radius at that hour when the series has it (it varies with distance), else a mean value.
  function fracAt(se, i, margin) { const d = (se.sunClr[i] - margin) / (se.sunRad ? se.sunRad[i] : SUNR); return d >= 1 ? 1 : d <= -1 ? 0 : 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI; }
  function mission(se, i0, cfg, margin, keep) {
    const want = Math.round(cfg.days * 24), n = Math.max(0, Math.min(want, se.n - i0));
    const cap = cfg.capWh, floor = cfg.minSoc * cap;
    let E = cap, minE = cap, kMin = 0, gap = 0, maxGap = 0, dark = 0, maxDark = 0, linkH = 0, litH = 0, draw = 0, maxDraw = 0, kFail = -1;
    // stress test: one fault from a chosen mission day, and an optional safe mode that sheds load when the battery runs low
    const F = cfg.fault && cfg.fault.kind !== 'none' ? cfg.fault : null, fk = F ? Math.round(F.day * 24) : 1e9; let capNow = cap, safe = false, safeH = 0;
    const soc = keep ? new Float32Array(n + 1) : null, sun = keep ? new Float32Array(n) : null, link = keep ? new Uint8Array(n) : null, safeArr = keep ? new Uint8Array(n) : null;
    if (soc) soc[0] = 1;
    for (let k = 0; k < n; k++) {
      const i = i0 + k, f = fracAt(se, i, margin);
      const on = k >= fk;
      const p = cfg.peakW * se.irr[i] * f * (cfg.tracking ? 1 : Math.max(0, Math.sin(se.sunEl[i] * Math.PI / 180))) * (on && F.kind === 'array' ? 0.7 : 1);
      if (on && F.kind === 'battery' && capNow === cap) { capNow = cap * 0.75; if (E > capNow) E = capNow; }
      let load = f > 0.02 ? cfg.loadSun : cfg.loadDark;
      if (cfg.safe) { if (!safe && E < 0.4 * capNow) safe = true; else if (safe && E > 0.7 * capNow) safe = false; if (safe) { load = Math.min(load, cfg.loadDark); safeH++; } }
      if (on && F.kind === 'load') load += 100;
      const net = p - load, dE = net > 0 ? net * cfg.chargeEff : net;
      E = Math.min(capNow, E + dE); if (E < minE) { minE = E; kMin = k + 1; } if (E < floor && kFail < 0) kFail = k + 1;
      draw = Math.min(0, draw + dE); if (-draw > maxDraw) maxDraw = -draw;
      const L = se.earthClr[i] - margin > 0 && !(on && F.kind === 'antenna' && k < fk + 24);
      if (L) { linkH++; gap = 0; } else { gap++; if (gap > maxGap) maxGap = gap; }
      if (f > 0.5) { litH++; dark = 0; } else { dark++; if (dark > maxDark) maxDark = dark; }
      if (keep) { soc[k + 1] = Math.max(0, E / cap); sun[k] = f; link[k] = L ? 1 : 0; safeArr[k] = safe ? 1 : 0; }
    }
    const fails = [];
    if (n < want) fails.push('the ephemeris window ends before the mission does');
    if (n > 0 && fracAt(se, i0, margin) <= 0.5) fails.push('the Sun is not up at landing');
    if (cfg.needEarth && n > 0 && !(se.earthClr[i0] - margin > 0)) fails.push('no Earth line of sight at landing');
    if (!isFinite(E) || !isFinite(minE)) fails.push('the mission inputs are not valid numbers');
    if (minE < floor) fails.push('battery falls to ' + Math.max(0, Math.round(100 * minE / cap)) + '% on day ' + (kMin / 24).toFixed(1));
    // emergency autonomy: even at its lowest charge the battery must carry the darkness load through an unplanned blackout
    const autoWh = (cfg.autonomyH || 0) * cfg.loadDark;
    if (autoWh > 0 && minE >= floor && minE - floor < autoWh) fails.push('battery cannot ride out a ' + cfg.autonomyH + ' h blackout (its lowest charge covers ' + ((minE - floor) / Math.max(1e-9, cfg.loadDark)).toFixed(1) + ' h)');
    if (cfg.needEarth && maxGap > cfg.maxGapH) fails.push('Earth is out of view for ' + (maxGap >= 48 ? (maxGap / 24).toFixed(1) + ' d' : maxGap + ' h') + ' (limit ' + cfg.maxGapH + ' h)');
    return { ok: fails.length === 0, fails, minSoc: Math.max(0, minE / cap), kMin, kFail, maxGapH: maxGap, maxDarkH: maxDark, linkPct: n ? 100 * linkH / n : 0, litPct: n ? 100 * litH / n : 0,
             // a battery fault leaves 75% of the capacity, and the reserve is a share of the full size, so less of it is usable
             battNeedWh: (F && F.kind === 'battery' ? 0.75 : 1) - cfg.minSoc > 0 ? (maxDraw + autoWh) / ((F && F.kind === 'battery' ? 0.75 : 1) - cfg.minSoc) : Infinity, n, soc, sun, link, safeH, safeArr, faultK: F ? fk : -1 };
  }
  // 2 = passes with the terrain margin, 1 = passes only without it, 0 = fails.
  function verdict(se, i0, cfg) {
    const nom = mission(se, i0, cfg, 0, false);
    if (!nom.ok) return { state: 0, nom, rob: null };
    const rob = mission(se, i0, cfg, cfg.margin, false);
    return { state: rob.ok ? 2 : 1, nom, rob };
  }
  // ---------- Monte Carlo landing-risk analysis ----------
  // Seeded random numbers: u() uniform in [0,1), n() standard normal. The same seed gives the same run.
  function rng(seed) {
    let a = seed >>> 0, spare = null;
    const u = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const n = () => { if (spare !== null) { const s = spare; spare = null; return s; } let x, y, r; do { x = u() * 2 - 1; y = u() * 2 - 1; r = x * x + y * y; } while (r >= 1 || r === 0); const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return x * f; };
    return { u, n };
  }
  // Decorrelates a seed, a cell index and a stream id (murmur3 finaliser), so every touchdown cell has its own random stream.
  function mix(seed, k, salt) { let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
  const CAUSES = ['Dark at landing', 'No Earth line of sight at landing', 'Battery too low', 'Link gap too long', 'Ground too steep', 'Other'];
  function causeOf(f) { return /Sun is not up/.test(f) ? 0 : /at landing/.test(f) ? 1 : /battery|blackout/.test(f) ? 2 : /out of view/.test(f) ? 3 : 5; }
  // K random missions for one touchdown cell. se is that cell's series; i0 the nominal landing sample in it.
  // sig: 1-sigma spreads {timeH, terrainDeg, power, load, cap}. Failure causes are added to counts[5]. Returns the success share.
  function cellTrials(se, i0, cfg, sig, R, K, counts) {
    let ok = 0; const c = Object.assign({}, cfg);
    for (let k = 0; k < K; k++) {
      // sig.corr: one shared "cold case" draw raises the loads and lowers the battery capacity together
      const z = R.n(), l = Math.max(0, 1 + sig.load * z), zc = sig.corr ? -z : R.n();
      c.peakW = cfg.peakW * Math.max(0, 1 + sig.power * R.n()); c.loadSun = cfg.loadSun * l; c.loadDark = cfg.loadDark * l; c.capWh = cfg.capWh * Math.max(0.1, 1 + sig.cap * zc);
      const i = Math.max(0, Math.min(se.n - Math.round(cfg.days * 24), i0 + Math.round(sig.timeH * R.n())));   // keep the whole mission inside the series
      const r = mission(se, i, c, sig.terrainDeg * R.n(), false);
      if (r.ok) ok++; else counts[causeOf(r.fails[0])]++;
    }
    return ok / K;
  }
  // Chance of success when aiming at cell (ax, ay): the per-cell success shares P (n x n, spacing s km)
  // averaged with a circular normal distribution of touchdown points (1-sigma = sigmaKm), cut at 3 sigma.
  function aimProb(P, n, s, ax, ay, sigmaKm) {
    let sw = 0, sp = 0, sw2 = 0; const r = Math.max(1, Math.ceil(3 * sigmaKm / s));
    for (let y = Math.max(0, ay - r); y <= Math.min(n - 1, ay + r); y++) for (let x = Math.max(0, ax - r); x <= Math.min(n - 1, ax + r); x++) {
      const d2 = ((x - ax) * (x - ax) + (y - ay) * (y - ay)) * s * s; if (d2 > 9 * sigmaKm * sigmaKm + 1e-9) continue;
      const w = Math.exp(-d2 / (2 * sigmaKm * sigmaKm)); sw += w; sw2 += w * w; sp += w * P[y * n + x];
    }
    return { p: sw ? sp / sw : 0, nEff: sw2 ? sw * sw / sw2 : 0 };
  }
  // ---------- inverse design: work back from the mission to the hardware ----------
  // Smallest value in [lo, hi] for which ok(x) holds, assuming ok is false below some threshold and true above it. null if ok(hi) is false.
  function bisectUp(ok, lo, hi, iters) { if (!ok(hi)) return null; if (ok(lo)) return lo; for (let k = 0; k < (iters || 12); k++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; } return hi; }
  // Smallest solar array (W) that passes with a battery of capWh. robust: test with the terrain margin applied.
  function minArray(se, i0, cfg, capWh, robust, pMax, iters) {
    const c = Object.assign({}, cfg, { capWh });
    return bisectUp(p => { c.peakW = p; return mission(se, i0, c, robust ? cfg.margin : 0, false).ok; }, 0, pMax, iters);
  }
  // Survival frontier: for a range of battery sizes, the smallest array that passes; and the lightest pair on it.
  // massOf: { wkg: array W per kg, whkg: battery Wh per kg }.
  function designFrontier(se, i0, cfg, massOf, nCap, iters, both) {
    const pMax = Math.max(3000, 12 * cfg.loadSun), c0 = 60, c1 = 60000, caps = [], rob = [], nom = [], mass = (p, c) => p / massOf.wkg + c / massOf.whkg;
    let best = null, bk = -1;
    for (let k = 0; k < nCap; k++) {
      const cap = c0 * Math.pow(c1 / c0, k / (nCap - 1)), pr = minArray(se, i0, cfg, cap, true, pMax, iters);
      caps.push(cap); rob.push(pr); nom.push(both ? minArray(se, i0, cfg, cap, false, pMax, iters) : null);
      if (pr !== null && (!best || mass(pr, cap) < best.mass)) { best = { peakW: pr, capWh: cap, mass: mass(pr, cap) }; bk = k; }
    }
    if (best) {            // refine the battery size between the neighbouring grid values
      let a = caps[Math.max(0, bk - 1)], b = caps[Math.min(nCap - 1, bk + 1)];
      for (let k = 0; k < 7; k++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3, p1 = minArray(se, i0, cfg, m1, true, pMax, iters), p2 = minArray(se, i0, cfg, m2, true, pMax, iters), f1 = p1 === null ? 1e9 : mass(p1, m1), f2 = p2 === null ? 1e9 : mass(p2, m2);
        if (f1 < best.mass) best = { peakW: p1, capWh: m1, mass: f1 }; if (f2 < best.mass) best = { peakW: p2, capWh: m2, mass: f2 }; if (f1 < f2) b = m2; else a = m1; }
      best.peakW = Math.ceil(best.peakW / 5) * 5; best.capWh = Math.ceil(best.capWh / 10) * 10; best.mass = mass(best.peakW, best.capWh);
    }
    return { caps, rob, nom, best, pMax };
  }
  // 95% Wilson interval for a share p estimated from n (effective) trials.
  function wilson(p, n) { const z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }
  // Like aimProb, plus the sampling variance: each cell's share comes from K trials, and cells count by their squared weight.
  function aimStats(P, n, s, ax, ay, sigmaKm, K) {
    let sw = 0, sp = 0, sw2 = 0, v = 0; const r = Math.max(1, Math.ceil(3 * sigmaKm / s)), inside = ax - r >= 0 && ay - r >= 0 && ax + r <= n - 1 && ay + r <= n - 1;
    for (let y = Math.max(0, ay - r); y <= Math.min(n - 1, ay + r); y++) for (let x = Math.max(0, ax - r); x <= Math.min(n - 1, ax + r); x++) {
      const d2 = ((x - ax) * (x - ax) + (y - ay) * (y - ay)) * s * s; if (d2 > 9 * sigmaKm * sigmaKm + 1e-9) continue;
      const w = Math.exp(-d2 / (2 * sigmaKm * sigmaKm)), q = P[y * n + x]; sw += w; sw2 += w * w; sp += w * q; v += w * w * q * (1 - q) / K;
    }
    const p = sw ? sp / sw : 0, vr = sw ? v / (sw * sw) : 0, nEff = vr > 1e-9 && p > 0 && p < 1 ? p * (1 - p) / vr : K * (sw2 ? sw * sw / sw2 : 1), ci = wilson(p, Math.max(1, nEff));
    return { p, var: Math.max(vr, p * (1 - p) / Math.max(1, K * (sw2 ? sw * sw / sw2 : 1))), nEff, lo: ci[0], hi: ci[1], inside };
  }
  return { siteMask, stateFrom, stateWith, wilson, aimStats, bisectUp, minArray, designFrontier, series, seriesAt, nextCross, stats, mission, verdict, fracAt, rng, mix, cellTrials, aimProb, CAUSES };
})();
if (typeof module !== 'undefined') module.exports = Ana;
