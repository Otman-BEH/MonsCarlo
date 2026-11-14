(async function () {
  const $ = id => document.getElementById(id);
  const DAY = 86400e3, HOUR = 3600e3, D2R = Math.PI / 180, R2D = 180 / Math.PI, RM = Eng.RM;
  const SYNODIC = 29.530589, TAB_DAYS = 428, VIEWS = ['plan', 'explore', 'compare', 'learn'];

  const SITES = [
    { id: 'shack', g: 'South pole', name: 'Shackleton rim', lat: -89.78, lon: -155.73, note: 'High-illumination point on the crater rim (LOLA Site 04).' },
    { id: 'ridge', g: 'South pole', name: 'Connecting ridge', lat: -89.45, lon: -137.31, note: 'Ridge between Shackleton and de Gerlache (LOLA Site 01).' },
    { id: 'gerl', g: 'South pole', name: 'de Gerlache rim', lat: -88.71, lon: -68.10, note: 'Rim of de Gerlache crater (LOLA Site 11).' },
    { id: 'ce7', g: 'South pole', name: "Chang'e 7 target, Shackleton rim", lat: -88.8, lon: 123.4, note: 'Published target for China\'s Chang\'e 7 lander.' },
    { id: 'mala', g: 'South pole', name: 'Malapert Massif', lat: -86.0, lon: 2.7, note: 'Artemis candidate region (LOLA Site 23).' },
    { id: 'viper', g: 'South pole', name: 'Mons Mouton, VIPER site', lat: -85.42, lon: 31.62, note: 'Planned landing area for NASA\'s VIPER rover.' },
    { id: 'im2', g: 'South pole', name: 'IM-2 Athena, Mons Mouton', lat: -84.7906, lon: 29.1957, note: 'Intuitive Machines IM-2 landed here on 6 March 2025.' },
    { id: 'im1', g: 'South pole', name: 'IM-1 Odysseus, Malapert A', lat: -80.13, lon: 1.44, note: 'Intuitive Machines IM-1 landed here on 22 February 2024.' },
    { id: 'pole', g: 'South pole', name: 'South pole', lat: -90, lon: 0, note: 'The geographic pole, on the wall of Shackleton crater.' },
    { id: 'a11', g: 'Past landings', name: 'Apollo 11, Tranquility Base', lat: 0.6741, lon: 23.4730, note: 'First crewed landing, July 1969.' },
    { id: 'a12', g: 'Past landings', name: 'Apollo 12', lat: -3.0124, lon: -23.4216, note: 'Oceanus Procellarum, November 1969.' },
    { id: 'a14', g: 'Past landings', name: 'Apollo 14', lat: -3.6453, lon: -17.4714, note: 'Fra Mauro, February 1971.' },
    { id: 'a15', g: 'Past landings', name: 'Apollo 15', lat: 26.1322, lon: 3.6339, note: 'Hadley Rille, July 1971.' },
    { id: 'a16', g: 'Past landings', name: 'Apollo 16', lat: -8.9730, lon: 15.5002, note: 'Descartes Highlands, April 1972.' },
    { id: 'a17', g: 'Past landings', name: 'Apollo 17', lat: 20.1908, lon: 30.7717, note: 'Taurus-Littrow, December 1972.' },
    { id: 'ce3', g: 'Past landings', name: "Chang'e 3", lat: 44.1214, lon: -19.5116, note: 'Mare Imbrium, December 2013.' },
    { id: 'ce4', g: 'Past landings', name: "Chang'e 4, far side", lat: -45.4446, lon: 177.5991, note: 'Von Kármán crater, first far-side landing, January 2019.' },
    { id: 'ce5', g: 'Past landings', name: "Chang'e 5", lat: 43.0576, lon: -51.9161, note: 'Mons Rümker region, sample return, December 2020.' },
    { id: 'ce6', g: 'Past landings', name: "Chang'e 6, far side", lat: -41.6385, lon: -153.9852, note: 'Apollo basin, far-side sample return, June 2024.' },
    { id: 'c3', g: 'Past landings', name: 'Chandrayaan-3', lat: -69.3733, lon: 32.3191, note: 'Shiv Shakti point, August 2023.' },
    { id: 'slim', g: 'Past landings', name: 'SLIM', lat: -13.3160, lon: 25.2510, note: 'Near Shioli crater, January 2024.' },
    { id: 'bg1', g: 'Past landings', name: 'Blue Ghost Mission 1', lat: 18.5623, lon: 61.8103, note: 'Mare Crisium, March 2025.' },
    { id: 'im3', g: 'Announced targets', name: 'IM-3, Reiner Gamma', lat: 7.585, lon: -58.725, note: 'CLPS target at the Reiner Gamma swirl; approximate.' },
    { id: 'bg2', g: 'Announced targets', name: 'Blue Ghost Mission 2, far side', lat: -23.8, lon: -177.7, note: 'CLPS far-side target; approximate.' },
    { id: 'bg3', g: 'Announced targets', name: 'Blue Ghost Mission 3, Gruithuisen Domes', lat: 36.3, lon: -40.2, note: 'CLPS target; approximate.' },
    { id: 'schr', g: 'Announced targets', name: 'Schrödinger basin', lat: -75.0, lon: 132.4, note: 'CLPS far-side target region; basin centre.' },
  ];
  const byId = id => id === 'custom' ? S.custom : SITES.find(s => s.id === id);
  const short = s => s.name.split(',')[0];

  const floorDay = t => Math.floor(t / DAY) * DAY, floorHour = t => Math.floor(t / HOUR) * HOUR;
  const t0 = Math.round(Date.now() / 60000) * 60000;
  const S = { site: SITES[0], custom: null, t: t0, eye: 2, span: 30, anchor: floorDay(t0), calAnchor: floorDay(t0), view: 'explore',
              cmp: ['mala', 'ridge'], mapTab: 'pole', layer: 'sun', playing: false, plan: null, slip: 14, flex: 21, scope: 'pole', acc: 500, tjit: 6, risk: null, sig: { power: 5, load: 5, cap: 3, terrain: 0.15, slope: 12, corr: false, seed: 20261114 },
              cfg: { days: 10, peakW: 400, loadSun: 180, loadDark: 60, capWh: 2000, minSoc: 0.2, tracking: true, needEarth: true, maxGapH: 12, margin: 0.3, chargeEff: 0.9, fault: { kind: 'none', day: 3 }, safe: false, autonomyH: 6 } };

  // ---------- formatting ----------
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = n => String(n).padStart(2, '0');
  function fmtDate(ms) { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtDM(ms) { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function fmtDT(ms) { const d = new Date(ms); return fmtDate(ms) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' UTC'; }
  function fmtDur(ms) {
    const h = ms / HOUR;
    if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
    if (h < 48) return Math.floor(h) + ' h ' + p2(Math.round((h - Math.floor(h)) * 60) % 60) + ' min';
    const d = Math.floor(h / 24); return d + ' d ' + Math.round(h - d * 24) + ' h';
  }
  const fmtH = h => h >= 48 ? (h / 24).toFixed(1) + ' d' : Math.round(h) + ' h';
  const fmtWh = w => !isFinite(w) ? 'No size is enough' : w >= 1000 ? (w / 1000).toFixed(w >= 10000 ? 0 : 1) + ' kWh' : Math.round(w) + ' Wh';
  const sg = (v, n) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(n) + '°';
  const fmtLat = v => Math.abs(v).toFixed(2) + '°' + (v < 0 ? 'S' : 'N');
  const fmtLon = v => { let l = ((v + 180) % 360 + 360) % 360 - 180; return Math.abs(l).toFixed(2) + '°' + (l < 0 ? 'W' : 'E'); };
  const compass = az => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  const STN = ['Fails', 'Marginal', 'Passes'], STL = ['Does not meet the needs', 'Marginal: sensitive to terrain', 'Meets the needs'];
  const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- theme and canvas ----------
  let C = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    C = { ink: v('--ink'), muted: v('--muted'), line: v('--line'), sun: v('--sun'), earth: v('--earth'), go: v('--go'), warn: v('--warn'), bad: v('--bad'), cell: v('--cell'), panel: v('--panel'), bg: v('--bg') };
  }
  const FONT = (px, w) => (w || 500) + ' ' + px + 'px Barlow, "Helvetica Neue", Arial, sans-serif';
  const FONTC = (px, w) => (w || 600) + ' ' + px + 'px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  const shown = el => el.offsetParent !== null;
  function prep(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  // ---------- one hourly ephemeris table, shared by every site ----------
  let tab = null; const serCache = new Map();
  function ensureTab() {
    if (S.anchor < S.calAnchor || S.anchor + (S.span + Math.max(45, S.cfg.days + 2)) * DAY > S.calAnchor + TAB_DAYS * DAY) S.calAnchor = S.anchor;
    if (!tab || tab.t0 !== S.calAnchor) { tab = Eng.makeTable(S.calAnchor, HOUR, TAB_DAYS * 24); serCache.clear(); rescueKey = ''; }
  }
  function ser(site) {
    const k = site.id + '|' + site.lat + '|' + site.lon + '|' + S.eye;
    let s = serCache.get(k); if (!s) { s = Ana.series(site, S.eye, tab); serCache.set(k, s); }
    return s;
  }
  const idx = t => Math.round((t - tab.t0) / HOUR);
  const cfgSig = () => JSON.stringify(S.cfg);
  function exact(site, t) { const b = Eng.bodyFixed(t); return Ana.stateFrom(site, S.eye, b.sun, b.earth); }
  function nextEvent(site, key) {
    const x = (S.t - tab.t0) / HOUR; if (x < 0 || x > tab.n - 1) return null;
    const c = Ana.nextCross(ser(site)[key], x, tab.n); if (!c) return null;
    let a = Math.max(S.t, tab.t0 + Math.floor(c.idx) * HOUR), b = tab.t0 + Math.ceil(c.idx + 1e-9) * HOUR, fa = exact(site, a)[key];
    if ((fa > 0) === (exact(site, b)[key] > 0)) return { t: tab.t0 + c.idx * HOUR, rising: c.rising };
    for (let k = 0; k < 11; k++) { const m = (a + b) / 2, fm = exact(site, m)[key]; if ((fa > 0) === (fm > 0)) { a = m; fa = fm; } else b = m; }
    return { t: (a + b) / 2, rising: c.rising };
  }
  const rows = () => [S.site].concat(S.cmp.filter(id => id !== S.site.id).map(byId).filter(Boolean)).slice(0, 5);
  function calStates(site) {
    const se = ser(site), sig = cfgSig();
    if (!se._cal || se._calSig !== sig) { const a = new Uint8Array(366); for (let d = 0; d < 366; d++) a[d] = Ana.verdict(se, d * 24, S.cfg).state; se._cal = a; se._calSig = sig; }
    return se._cal;
  }
  function tierText(m) { return m.tier === 'LOLA 80 m' ? 'horizon from the 80 m LOLA model' : m.tier === 'LOLA 80 to 400 m' ? 'horizon from the LOLA model, 80 m nearby and 400 m far away' : m.tier === 'LOLA 400 m' ? 'horizon from the LOLA model at 400 m' : 'horizon from a coarse LOLA grid (' + m.tier.slice(5) + ')'; }

  // ---------- plan: mission verdict and survival timeline ----------
  function landingIndex() { return Math.max(0, Math.min(tab.n - 1, Math.floor((S.t - tab.t0) / HOUR))); }
  function drawMission() {
    const se = ser(S.site), i0 = landingIndex(), cfg = S.cfg;
    const nom = Ana.mission(se, i0, cfg, 0, true), rob = Ana.mission(se, i0, cfg, cfg.margin, true), st = !nom.ok ? 0 : rob.ok ? 2 : 1;
    S.mv = { nom, rob, st, t: tab.t0 + i0 * HOUR };
    $('mv-pill').innerHTML = '<span class="pill big ' + ['bad', 'warn', 'go'][st] + '">' + STL[st] + '</span>';
    const where = short(S.site) + ', landing ' + fmtDT(S.mv.t) + ', ' + cfg.days + '-day mission: ';
    $('mv-say').textContent = where + (st === 2 ? 'power and Earth contact hold for the whole mission, even with every horizon raised by ' + cfg.margin + '°.'
      : st === 1 ? 'it works on the modelled terrain, but with horizons raised by ' + cfg.margin + '° ' + rob.fails.join(' and ') + '.'
      : nom.fails.join(', and ') + '.');
    $('mv-soc').textContent = Math.round(nom.minSoc * 100) + '%'; $('mv-soc-s').textContent = 'On mission day ' + (nom.kMin / 24).toFixed(1) + ' · reserve ' + Math.round(cfg.minSoc * 100) + '% · with margin ' + Math.round(rob.minSoc * 100) + '%';
    $('mv-gap').textContent = fmtH(nom.maxGapH); $('mv-gap-s').textContent = (cfg.needEarth ? 'Limit ' + cfg.maxGapH + ' h' : 'No direct link required') + ' · Earth in view ' + nom.linkPct.toFixed(0) + '% of the mission';
    $('mv-need').textContent = fmtWh(nom.battNeedWh); $('mv-need-s').textContent = 'To ride out the longest shortfall with the reserve · fitted ' + fmtWh(cfg.capWh);
    $('mv-lit').textContent = nom.litPct.toFixed(0) + '%'; $('mv-lit-s').textContent = 'Longest dark stretch ' + fmtH(nom.maxDarkH) + ' · with margin ' + rob.litPct.toFixed(0) + '%';
    const FN = { array: 'the solar array loses 30% of its output', load: 'an unexpected 100 W load appears', battery: 'the battery loses 25% of its capacity', antenna: 'the antenna is down for 24 hours' };
    if (cfg.fault.kind === 'none') $('mv-fault').textContent = cfg.safe && nom.safeH ? 'Safe mode was needed for ' + nom.safeH + ' h even with nothing broken.' : '';
    else {
      const clean = Ana.mission(se, i0, Object.assign({}, cfg, { fault: { kind: 'none', day: 0 } }), 0, false), other = Ana.mission(se, i0, Object.assign({}, cfg, { safe: !cfg.safe }), 0, false), out = r => r.ok ? 'the mission survives' : 'the mission fails (' + r.fails[0] + ')';
      $('mv-fault').textContent = 'Stress test: on mission day ' + cfg.fault.day + ' ' + FN[cfg.fault.kind] + '. ' + (clean.ok ? 'Without the fault the mission passes. ' : 'The mission fails even without the fault. ')
        + (cfg.safe ? 'With safe mode ' + out(nom) + (nom.safeH ? ', spending ' + nom.safeH + ' h at reduced power' : ', and safe mode is never triggered') + '. Without it ' + out(other) + '.'
                    : 'Without safe mode ' + out(nom) + '. With it ' + out(other) + (other.safeH ? ', at the cost of ' + other.safeH + ' h at reduced power.' : '.'));
    }
    const cv = $('surv'); if (!shown(cv)) return;
    const { g, w, h } = prep(cv), px = 52, pw = w - px - 10, n = nom.n, bt = 44, bh = h - bt - 24;
    const X = k => px + k / Math.max(1, n) * pw, Y = v => bt + (1 - v) * bh;
    g.font = FONTC(12, 500); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = C.muted;
    g.fillText('SUN', px - 6, 8); g.fillText('EARTH', px - 6, 24);
    g.fillStyle = C.cell; g.fillRect(px, 2, pw, 12); g.fillRect(px, 18, pw, 12);
    for (let k = 0; k < n; k++) {
      const x = X(k), ww = pw / n + 0.5;
      if (nom.sun[k] > 0) { g.globalAlpha = 0.25 + 0.75 * nom.sun[k]; g.fillStyle = C.sun; g.fillRect(x, 2, ww, 12); }
      if (nom.link[k]) { g.globalAlpha = 1; g.fillStyle = C.earth; g.fillRect(x, 18, ww, 12); }
    }
    g.globalAlpha = 0.28; g.fillStyle = C.warn; for (let k = 0; k < n; k++) if (nom.safeArr[k]) g.fillRect(X(k), bt, pw / n + 0.5, bh);
    g.globalAlpha = 1; g.font = FONT(11);
    for (const v of [0, 0.5, 1]) { g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(px, Y(v)); g.lineTo(px + pw, Y(v)); g.stroke(); g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(Math.round(v * 100) + '%', px - 6, Y(v)); }
    g.setLineDash([5, 4]); g.strokeStyle = C.bad; g.beginPath(); g.moveTo(px, Y(cfg.minSoc)); g.lineTo(px + pw, Y(cfg.minSoc)); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.bad; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.font = FONTC(12, 500); g.fillText('RESERVE', px + 4, Y(cfg.minSoc) - 2);
    const line = (soc, col, lw, dash, fill) => {
      g.beginPath(); for (let k = 0; k <= n; k++) { k ? g.lineTo(X(k), Y(soc[k])) : g.moveTo(X(k), Y(soc[k])); }
      if (fill) { g.save(); g.lineTo(X(n), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.globalAlpha = 0.16; g.fillStyle = col; g.fill(); g.restore(); g.beginPath(); for (let k = 0; k <= n; k++) { k ? g.lineTo(X(k), Y(soc[k])) : g.moveTo(X(k), Y(soc[k])); } }
      g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash); g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
    };
    line(rob.soc, C.muted, 1.3, [3, 3], false); line(nom.soc, C.go, 2, [], true);
    if (nom.faultK >= 0 && nom.faultK <= n) { const x = X(nom.faultK); g.setLineDash([2, 3]); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, bt + bh); g.stroke(); g.setLineDash([]); g.fillStyle = C.ink; g.font = FONTC(12); g.textBaseline = 'top'; g.textAlign = x > px + pw - 60 ? 'right' : 'left'; g.fillText('FAULT', x + (x > px + pw - 60 ? -5 : 5), bt + 16); }
    if (nom.kFail > 0) { const x = X(nom.kFail); g.strokeStyle = C.bad; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, bt + bh); g.stroke(); g.fillStyle = C.bad; g.font = FONTC(12); g.textBaseline = 'top'; g.textAlign = x > px + pw - 120 ? 'right' : 'left'; g.fillText('RESERVE BREACHED', x + (x > px + pw - 120 ? -5 : 5), bt + 2); }
    g.font = FONT(11); g.fillStyle = C.muted; g.textBaseline = 'top'; const days = n / 24, per = pw / Math.max(1, days), stepD = [1, 2, 5, 10, 20].find(v => v * per >= 46) || 30;
    for (let d = 0; d <= days + 1e-9; d += stepD) { const x = X(d * 24); g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, bt + bh); g.lineTo(x, bt + bh + 4); g.stroke(); if (d > 0 && d * per < 52) continue; g.textAlign = d === 0 ? 'left' : d >= days - 0.01 ? 'right' : 'center'; g.fillText(d === 0 ? 'Landing' : 'Day ' + d, x, bt + bh + 7); }
  }

  // ---------- plan: design lab (inverse design) ----------
  const LAB = { wkg: 80, whkg: 160, fKey: '', F: null, aKey: '', atlas: null, geo: null, ageo: null };
  const fmtKg = m => (m < 10 ? m.toFixed(1) : Math.round(m)) + ' kg', fmtW = p => Math.round(p).toLocaleString('en-US') + ' W', fmtCap = c => Math.round(c).toLocaleString('en-US') + ' Wh';
  const hwSig = () => { const c = Object.assign({}, S.cfg); delete c.peakW; delete c.capWh; return JSON.stringify(c); };      // everything except the hardware being solved for
  const labMass = (p, c) => p / LAB.wkg + c / LAB.whkg;
  function setHardware(p, c) { $('m-peak').value = Math.round(p); $('m-cap').value = Math.round(c); readCfg(); }
  function drawLab() {
    const cv = $('dfront'); if (!shown(cv)) return;
    const se = ser(S.site), i0 = landingIndex(), cfg = S.cfg, massOf = { wkg: LAB.wkg, whkg: LAB.whkg };
    const fk = [S.site.lat, S.site.lon, i0, tab.t0, hwSig(), S.eye, LAB.wkg, LAB.whkg].join('|');
    if (LAB.fKey !== fk) { LAB.fKey = fk; LAB.F = Ana.designFrontier(se, i0, cfg, massOf, 36, 12, true); }
    const F = LAB.F, b = F.best, st = S.mv.st, mc = labMass(cfg.peakW, cfg.capWh), passR = c => Ana.mission(se, i0, c, cfg.margin, false).ok;
    $('d-apply').hidden = !b;
    if (b) { $('d-best').textContent = fmtW(b.peakW) + ' + ' + fmtCap(b.capWh); $('d-best-s').textContent = 'About ' + fmtKg(b.mass) + ' of array and battery. A screening figure from the W per kg and Wh per kg above.'; }
    else { const why = Ana.mission(se, i0, Object.assign({}, cfg, { peakW: F.pMax, capWh: 60000 }), cfg.margin, false).fails[0] || 'the needs cannot be met'; $('d-best').textContent = 'None'; $('d-best-s').textContent = 'No array and battery pass at this landing time, because ' + why + '. Try another time in the atlas below.'; }
    $('d-cur').textContent = STN[st]; $('d-cur-s').textContent = fmtW(cfg.peakW) + ' + ' + fmtCap(cfg.capWh) + ', about ' + fmtKg(mc) + (b ? (st === 2 ? (mc - b.mass > 0.05 ? ' · ' + fmtKg(mc - b.mass) + ' more than the lightest' : ' · as light as it gets') : ' · the lightest passing design is ' + fmtKg(b.mass)) : '');
    $('d-pill').innerHTML = !b ? '<span class="pill big bad">No hardware works at this time</span>' : st === 2 ? '<span class="pill big go">' + ((mc - b.mass) / b.mass < 0.15 ? 'Lean design' : 'Passes, with mass to spare') + '</span>' : '<span class="pill big ' + (st === 1 ? 'warn">Marginal: needs more hardware' : 'bad">Fails: needs more hardware') + '</span>';
    // engineering alternatives
    const alts = [];
    if (b) {
      const pa = Ana.minArray(se, i0, cfg, cfg.capWh, true, F.pMax, 14), cb = Ana.bisectUp(c => passR(Object.assign({}, cfg, { capWh: c })), 10, 60000, 16);
      alts.push(pa === null ? 'Keeping the ' + fmtCap(cfg.capWh) + ' battery: no array size is enough.' : 'Keeping the ' + fmtCap(cfg.capWh) + ' battery: the array ' + (pa > cfg.peakW ? 'must grow to ' : 'could shrink to ') + fmtW(Math.ceil(pa / 5) * 5) + ' (' + (pa > cfg.peakW ? '+' : '−') + fmtKg(Math.abs(pa - cfg.peakW) / LAB.wkg) + ').');
      alts.push(cb === null ? 'Keeping the ' + fmtW(cfg.peakW) + ' array: no battery size is enough.' : 'Keeping the ' + fmtW(cfg.peakW) + ' array: the battery ' + (cb > cfg.capWh ? 'must grow to ' : 'could shrink to ') + fmtCap(Math.ceil(cb / 10) * 10) + ' (' + (cb > cfg.capWh ? '+' : '−') + fmtKg(Math.abs(cb - cfg.capWh) / LAB.whkg) + ').');
      if (st < 2) { const x = Ana.bisectUp(v => passR(Object.assign({}, cfg, { loadSun: -v })), -cfg.loadSun, 0, 14); alts.push(x === null || -x < 1 ? 'Cutting the sunlight load alone cannot save this hardware.' : 'Keeping all hardware: cut the sunlight load from ' + fmtW(cfg.loadSun) + ' to ' + fmtW(Math.floor(-x)) + '.'); }
    }
    $('d-alt').innerHTML = alts.length ? '<div class="bt">Ways to make ' + (st === 2 ? 'it lighter' : 'it pass') + '</div><ul class="alts">' + alts.map(a => '<li>' + a + '</li>').join('') + '</ul>' : '';
    // survival frontier
    const { g, w, h } = prep(cv), L = 50, Rm = 12, T = 12, B = 30, pw = w - L - Rm, ph = h - T - B, x0 = Math.log(60), x1 = Math.log(60000), y0 = Math.log(20), y1 = Math.log(F.pMax);
    const X = c => L + (Math.log(c) - x0) / (x1 - x0) * pw, Y = p => T + (1 - (Math.log(Math.max(20, Math.min(F.pMax, p))) - y0) / (y1 - y0)) * ph;
    LAB.geo = { L, T, pw, ph, x0, x1, y0, y1 };
    g.fillStyle = C.cell; g.fillRect(L, T, pw, ph);
    const region = (lower, upper, col) => { const idx = F.caps.map((_, k) => k).filter(k => lower[k] !== null); if (!idx.length) return; g.beginPath(); idx.forEach((k, j) => { const x = X(F.caps[k]), y = Y(lower[k]); j ? g.lineTo(x, y) : g.moveTo(x, y); }); for (let j = idx.length - 1; j >= 0; j--) { const k = idx[j]; g.lineTo(X(F.caps[k]), upper && upper[k] !== null ? Y(upper[k]) : T); } g.closePath(); g.fillStyle = col; g.globalAlpha = 0.45; g.fill(); g.globalAlpha = 1; };
    region(F.nom, null, C.warn); g.fillStyle = C.cell; region(F.rob, null, C.cell); g.globalAlpha = 1; region(F.rob, null, C.go);
    const line = (arr, col, lw) => { g.beginPath(); let pen = false; F.caps.forEach((c, k) => { if (arr[k] === null) { pen = false; return; } const x = X(c), y = Y(arr[k]); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; }); g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke(); };
    line(F.nom, C.warn, 1.5); line(F.rob, C.go, 2.2);
    g.font = FONT(11); g.fillStyle = C.muted; g.strokeStyle = C.line; g.lineWidth = 1; g.textAlign = 'center'; g.textBaseline = 'top';
    [[100, '100 Wh'], [1000, '1 kWh'], [10000, '10 kWh']].forEach(([c, t]) => { g.beginPath(); g.moveTo(X(c), T + ph); g.lineTo(X(c), T + ph + 4); g.stroke(); g.fillText(t, X(c), T + ph + 7); });
    g.textAlign = 'right'; g.textBaseline = 'middle'; [50, 100, 200, 500, 1000, 2000].forEach(p => { if (p > F.pMax) return; g.beginPath(); g.moveTo(L - 4, Y(p)); g.lineTo(L, Y(p)); g.stroke(); g.fillText(p + ' W', L - 7, Y(p)); });
    g.font = FONTC(12, 500); g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.fillText('BATTERY SIZE', L + pw, T + ph + 28); g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('SOLAR ARRAY OUTPUT', L + 6, T + 5);
    if (b) { g.setLineDash([4, 4]); g.strokeStyle = C.muted; g.lineWidth = 1.2; g.beginPath(); let pen = false; for (let k = 0; k <= 80; k++) { const c = Math.exp(x0 + (x1 - x0) * k / 80), p = (b.mass - c / LAB.whkg) * LAB.wkg; if (p < 20) break; const x = X(c), y = Y(p); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } g.stroke(); g.setLineDash([]); }
    const tagAt = (t, x, y) => { g.font = FONTC(13); const tw = g.measureText(t).width, lx = x + 10 + tw > L + pw ? x - 10 - tw : x + 10; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = C.panel; g.strokeText(t, lx, y); g.fillStyle = C.ink; g.fillText(t, lx, y); };
    if (b) { const x = X(b.capWh), y = Y(b.peakW); g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fillStyle = C.go; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.stroke(); tagAt('Lightest, ' + fmtKg(b.mass), x, y - 14); }
    { const x = X(Math.max(60, Math.min(60000, cfg.capWh))), y = Y(cfg.peakW); g.beginPath(); g.arc(x, y, 6, 0, 7); g.fillStyle = C.panel; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.5; g.stroke(); tagAt('Yours, ' + fmtKg(mc), x, y + 15); }
    // A/B battery chart
    const ab = $('dab'), A = prep(ab), ag = A.g, aw = A.w, ah = A.h, apx = 46, apw = aw - apx - 10, at = 8, ahh = ah - at - 22, n = S.mv.nom.n, AX = k => apx + k / Math.max(1, n) * apw, AY = v => at + (1 - v) * ahh;
    ag.font = FONT(11); ag.textBaseline = 'middle'; ag.textAlign = 'right';
    for (const v of [0, 0.5, 1]) { ag.strokeStyle = C.line; ag.lineWidth = 1; ag.beginPath(); ag.moveTo(apx, AY(v)); ag.lineTo(apx + apw, AY(v)); ag.stroke(); ag.fillStyle = C.muted; ag.fillText(Math.round(v * 100) + '%', apx - 6, AY(v)); }
    ag.setLineDash([5, 4]); ag.strokeStyle = C.bad; ag.beginPath(); ag.moveTo(apx, AY(cfg.minSoc)); ag.lineTo(apx + apw, AY(cfg.minSoc)); ag.stroke(); ag.setLineDash([]);
    const soc = (arr, col, lw) => { ag.beginPath(); for (let k = 0; k <= n; k++) { k ? ag.lineTo(AX(k), AY(arr[k])) : ag.moveTo(AX(k), AY(arr[k])); } ag.strokeStyle = col; ag.lineWidth = lw; ag.lineJoin = 'round'; ag.stroke(); };
    soc(S.mv.nom.soc, C.muted, 1.6); if (b) soc(Ana.mission(se, i0, Object.assign({}, cfg, { peakW: b.peakW, capWh: b.capWh }), 0, true).soc, C.go, 2.2);
    ag.fillStyle = C.muted; ag.textBaseline = 'top'; ag.textAlign = 'left'; ag.fillText('Landing', apx, at + ahh + 6); ag.textAlign = 'right'; ag.fillText('Day ' + cfg.days + ' · battery level, each as a share of its own capacity', apx + apw, at + ahh + 6);
    drawAtlas(se, massOf);
  }
  function drawAtlas(se, massOf) {
    const cv = $('datlas'), cfg = S.cfg, NA = 120, a0 = Math.max(0, Math.floor((floorDay(S.t) - tab.t0) / HOUR) - 5 * 24), key = [S.site.lat, S.site.lon, a0, tab.t0, hwSig(), S.eye, LAB.wkg, LAB.whkg].join('|');
    if (LAB.aKey !== key) {
      LAB.aKey = key; const m = new Float32Array(NA).fill(NaN), pk = new Float32Array(NA), cp = new Float32Array(NA);
      for (let j = 0; j < NA; j++) { const i = a0 + j * 12; if (i + cfg.days * 24 > tab.n) break; const F = Ana.designFrontier(se, i, cfg, massOf, 12, 9, false); if (F.best) { m[j] = F.best.mass; pk[j] = F.best.peakW; cp[j] = F.best.capWh; } }
      const order = []; for (let j = 0; j < NA; j++) if (m[j] === m[j]) order.push(j); order.sort((a, b) => m[a] - m[b]);
      const top = []; for (const j of order) { if (top.every(q => Math.abs(q - j) >= 6)) top.push(j); if (top.length === 4) break; }
      LAB.atlas = { a0, m, pk, cp, top };
    }
    const A = LAB.atlas, { g, w, h } = prep(cv), L = 46, Rm = 10, T = 10, ch = h - T - 30, pw = w - L - Rm, t0 = tab.t0 + A.a0 * HOUR, span = 60;
    let mx = 0; for (const v of A.m) if (v === v && v > mx) mx = v; mx = mx ? mx * 1.2 : 1;
    const X = j => L + j / NA * pw, Y = v => T + (1 - v / mx) * ch; LAB.ageo = { L, pw, NA };
    g.fillStyle = C.cell; for (let j = 0; j < NA; j++) if (!(A.m[j] === A.m[j])) g.fillRect(X(j), T, pw / NA + 0.5, ch);
    g.font = FONT(11); g.textAlign = 'right'; g.textBaseline = 'middle'; const stepM = mx > 40 ? 20 : mx > 16 ? 5 : mx > 6 ? 2 : 1;
    for (let v = 0; v <= mx; v += stepM) { g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke(); g.fillStyle = C.muted; g.fillText(v + ' kg', L - 6, Y(v)); }
    for (let j = 0; j < NA; j++) { if (!(A.m[j] === A.m[j])) continue; let e = j; while (e + 1 < NA && A.m[e + 1] === A.m[e + 1]) e++;
      g.beginPath(); g.moveTo(X(j), Y(0)); for (let k = j; k <= e; k++) g.lineTo(X(k + 0.5), Y(A.m[k])); g.lineTo(X(e + 1), Y(0)); g.closePath(); g.fillStyle = C.go; g.globalAlpha = 0.16; g.fill(); g.globalAlpha = 1;
      g.beginPath(); for (let k = j; k <= e; k++) { k === j ? g.moveTo(X(k + 0.5), Y(A.m[k])) : g.lineTo(X(k + 0.5), Y(A.m[k])); } if (e === j) g.lineTo(X(j + 1), Y(A.m[j])); g.strokeStyle = C.go; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke(); j = e; }
    timeAxis(g, L, T + ch + 2, pw, t0, span);
    const cx = L + (S.t - t0) / (span * DAY) * pw; if (cx >= L && cx <= L + pw) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ch); g.stroke(); }
    if (A.top.length) { const j = A.top[0], x = X(j + 0.5), y = Y(A.m[j]); g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fillStyle = C.go; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.stroke();
      g.font = FONTC(13); const t = 'Lightest: ' + fmtKg(A.m[j]), tw = g.measureText(t).width; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = C.panel; const lx = x + 10 + tw > L + pw ? x - 10 - tw : x + 10; g.strokeText(t, lx, y - 12); g.fillStyle = C.ink; g.fillText(t, lx, y - 12); }
    const mc = labMass(cfg.peakW, cfg.capWh);
    $('d-tbl').innerHTML = A.top.length ? '<thead><tr><th>Land on</th><th>Solar array</th><th>Battery</th><th>Mass</th><th>Against your design</th><th></th></tr></thead><tbody>' + A.top.map(j => '<tr><td>' + fmtDT(t0 + j * 12 * HOUR).replace(' UTC', '') + '</td><td>' + fmtW(A.pk[j]) + '</td><td>' + fmtCap(A.cp[j]) + '</td><td>' + fmtKg(A.m[j]) + '</td><td>' + (A.m[j] <= mc ? '−' : '+') + fmtKg(Math.abs(A.m[j] - mc)) + '</td><td><button type="button" data-ai="' + j + '">Use date and design</button></td></tr>').join('') + '</tbody>'
      : '<tbody><tr><td>No landing time in these 60 days works with any hardware, for this site and these mission needs.</td></tr></tbody>';
  }

  // ---------- plan: landing risk (Monte Carlo) ----------
  const RK = { n: 15, K: 48 }; let riskRun = 0, riskTimer = 0, riskBusy = false;
  const riskOk = () => Terrain.hasPolar() && S.site.lat <= -80.05;
  const riskKey = () => [S.site.lat, S.site.lon, landingIndex(), tab.t0, cfgSig(), S.eye, S.acc, S.tjit, JSON.stringify(S.sig)].join('|');
  const fmtDist = km => km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
  async function runRisk() {
    if (!ready || !riskOk()) { drawRisk(); return; }
    const my = ++riskRun, key = riskKey(), cfg = Object.assign({}, S.cfg), n = RK.n, K = RK.K, half = K / 2, Rkm = S.acc / 1000, W = 2.5 * Rkm, sp = 2 * W / (n - 1), sigma = Rkm / 3, g = S.sig;
    const J = Math.ceil(4 * S.tjit / 3) + 1, i0 = landingIndex(), start = Math.max(0, i0 - J), len = Math.min(tab.n - start, (i0 - start) + J + cfg.days * 24 + 1), is = i0 - start;
    const sig = { timeH: S.tjit / 3, terrainDeg: g.terrain, power: g.power / 100, load: g.load / 100, cap: g.cap / 100, corr: g.corr };
    const rho0 = 2 * RM * Math.tan((90 + Math.max(-89.999, S.site.lat)) / 2 * D2R), x0 = rho0 * Math.sin(S.site.lon * D2R), y0 = rho0 * Math.cos(S.site.lon * D2R), E = Terrain.elevXY;
    // two independent halves of the draws: A picks the best aim point, B checks it, so the check is not biased by the choice
    const PA = new Float32Array(n * n), PB = new Float32Array(n * n), P = new Float32Array(n * n), det = new Uint8Array(n * n), cause = new Uint16Array(n * n * 6), lat = new Float64Array(n * n), lon = new Float64Array(n * n), slope = new Float32Array(n * n), sers = new Array(n * n);
    const c = (n - 1) / 2;
    riskBusy = true; let last = performance.now();
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const k = iy * n + ix, x = x0 + (ix - c) * sp, y = y0 + (c - iy) * sp, rho = Math.hypot(x, y);
        lat[k] = Math.max(-89.999, -90 + 2 * Math.atan(rho / (2 * RM)) * R2D); lon[k] = Math.atan2(x, y) * R2D;
        slope[k] = Math.atan(Math.hypot(E(x + 0.08, y) - E(x - 0.08, y), E(x, y + 0.08) - E(x, y - 0.08)) / 160) * R2D;
        if (slope[k] > g.slope) { cause[k * 6 + 4] = K; continue; }                       // too steep to land on: every trial here fails
        const site = { lat: lat[k], lon: lon[k] }, m = Terrain.horizonMask(site.lat, site.lon, S.eye, 180), se = Ana.seriesAt(site, S.eye, m, tab, start, len), cs = cause.subarray(k * 6, k * 6 + 6);
        PA[k] = Ana.cellTrials(se, is, cfg, sig, Ana.rng(Ana.mix(g.seed, k, 0)), half, cs); PB[k] = Ana.cellTrials(se, is, cfg, sig, Ana.rng(Ana.mix(g.seed, k, 1)), half, cs); P[k] = (PA[k] + PB[k]) / 2; det[k] = Ana.verdict(se, is, cfg).state;
        if (Math.hypot(ix - c, iy - c) * sp <= Rkm + 1e-9) sers[k] = se;
      }
      if (performance.now() - last > 50) { $('k-msg').textContent = 'Simulating… ' + Math.round(100 * (iy + 1) / n) + '%'; await new Promise(r => setTimeout(r, 0)); last = performance.now(); if (my !== riskRun) return; }
    }
    riskBusy = false; if (my !== riskRun) return;
    const cur = Ana.aimStats(P, n, sp, c, c, sigma, K), cw = [0, 0, 0, 0, 0, 0]; let sw = 0;
    const wts = []; for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) { const d2 = ((ix - c) * (ix - c) + (iy - c) * (iy - c)) * sp * sp; if (d2 > Rkm * Rkm + 1e-9) continue; const w = Math.exp(-d2 / (2 * sigma * sigma)), k = iy * n + ix; wts.push([k, w]); sw += w; for (let j = 0; j < 6; j++) cw[j] += w * cause[k * 6 + j] / K; }
    // best aim point: chosen on half A, then judged on half B
    let pick = { p: Ana.aimStats(PA, n, sp, c, c, sigma, half).p, ix: c, iy: c };
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) { if (Math.hypot(ix - c, iy - c) * sp > 1.5 * Rkm + 1e-9) continue; const a = Ana.aimStats(PA, n, sp, ix, iy, sigma, half); if (a.inside && a.p > pick.p + 1e-9) pick = { p: a.p, ix, iy }; }
    const vb = Ana.aimStats(PB, n, sp, pick.ix, pick.iy, sigma, half), vc = Ana.aimStats(PB, n, sp, c, c, sigma, half), diff = vb.p - vc.p, se2 = Math.sqrt(vb.var + vc.var);
    const dx = (pick.ix - c) * sp, dy = (c - pick.iy) * sp, so = Math.sin(S.site.lon * D2R), co = Math.cos(S.site.lon * D2R);
    const best = { ix: pick.ix, iy: pick.iy, p: vb.p, lo: vb.lo, hi: vb.hi, gain: diff, clear: (pick.ix !== c || pick.iy !== c) && diff >= 0.03 && diff - 1.96 * se2 > 0, dist: Math.hypot(dx, dy), bearing: (Math.atan2(dx * co - dy * so, dx * so + dy * co) * R2D + 360) % 360, lat: lat[pick.iy * n + pick.ix], lon: lon[pick.iy * n + pick.ix] };
    // what drives the risk: the same draws as the main run with one source of error switched off (common random numbers), so the differences are like for like
    const dump = new Uint16Array(6), without = z => { let sp2 = 0; const s2 = Object.assign({}, sig, z); for (const [k, w] of wts) { const se = sers[k]; if (!se) continue; sp2 += w * (Ana.cellTrials(se, is, cfg, s2, Ana.rng(Ana.mix(g.seed, k, 0)), half, dump) + Ana.cellTrials(se, is, cfg, s2, Ana.rng(Ana.mix(g.seed, k, 1)), half, dump)) / 2; } return sp2 / sw; };
    const drivers = [['An exact touchdown', P[c * n + c]], ['An exact landing time', without({ timeH: 0 })], ['Perfect terrain data', without({ terrainDeg: 0 })], ['Hardware exactly as specified', without({ power: 0, load: 0, cap: 0 })]];
    let steep = 0; for (const [k, w] of wts) if (slope[k] > g.slope) steep += w;
    S.risk = { key, n, sp, W, E: W + sp / 2, Rkm, sigma, x0, y0, P, det, lat, lon, slope, p: cur.p, lo: cur.lo, hi: cur.hi, causes: cw.map(v => v / sw), best, drivers, steep: steep / sw, total: n * n * K, bg: null };
    $('k-msg').textContent = ''; drawRisk();
  }
  function scheduleRisk() { if (!riskOk() || S.playing) return; if (S.risk && S.risk.key === riskKey() && !riskBusy) return; clearTimeout(riskTimer); riskTimer = setTimeout(runRisk, 350); }
  function drawRisk() {
    const cv = $('risk'), r = S.risk, cur = !!r && r.key === riskKey();
    if (!riskOk()) {
      $('k-pill').innerHTML = ''; ['k-p', 'k-det', 'k-best'].forEach(id => { $(id).textContent = '—'; }); ['k-p-s', 'k-det-s', 'k-best-s'].forEach(id => { $(id).textContent = ''; }); $('k-causes').innerHTML = ''; $('k-drivers').innerHTML = ''; $('k-go').disabled = true;
      $('k-cap').textContent = 'This analysis needs the 400 m terrain, which covers 80°S to the south pole. Pick a south-pole site to use it.';
    } else if (r) {
      const pc = Math.round(r.p * 100), lvl = r.p >= 0.9 ? ['go', 'Low risk'] : r.p >= 0.6 ? ['warn', 'Moderate risk'] : ['bad', 'High risk'];
      $('k-pill').innerHTML = cur ? '<span class="pill big ' + lvl[0] + '">' + lvl[1] + '</span>' : '<span class="pill big off">Updating…</span>';
      $('k-p').textContent = pc + '%'; $('k-p-s').textContent = '95% interval ' + Math.round(r.lo * 100) + ' to ' + Math.round(r.hi * 100) + '% · ' + r.total.toLocaleString('en-US') + ' simulated missions';
      const mid = (r.n * r.n - 1) / 2, d = r.slope[mid] > S.sig.slope ? 0 : r.det[mid]; $('k-det').textContent = STN[d]; $('k-det-s').textContent = 'Nothing varied · slope at the aim point ' + r.slope[mid].toFixed(0) + '°';
      const better = r.best.clear;
      $('k-best').textContent = better ? Math.round(r.best.p * 100) + '%' : 'Current aim'; $('k-go').disabled = !better || !cur; $('k-go').hidden = !better;
      $('k-best-s').textContent = better ? 'Checked on a separate set of draws: 95% interval ' + Math.round(r.best.lo * 100) + ' to ' + Math.round(r.best.hi * 100) + '%. Move the aim ' + fmtDist(r.best.dist) + ' toward ' + r.best.bearing.toFixed(0) + '° ' + compass(r.best.bearing) + ', to ' + fmtLat(r.best.lat) + ' ' + fmtLon(r.best.lon) : 'No aim point within ' + fmtDist(1.5 * r.Rkm) + ' is clearly better when checked on a separate set of draws';
      const fail = 1 - r.p; let h = '<div class="bt">Why missions fail, as a share of all simulated missions</div>';
      Ana.CAUSES.forEach((nm, j) => { if (j >= 4 && r.causes[j] < 0.005) return; h += '<div class="br"><span>' + nm + '</span><span class="bb"><i style="width:' + Math.min(100, r.causes[j] * 100).toFixed(1) + '%"></i></span><span class="bv">' + Math.round(r.causes[j] * 100) + '%</span></div>'; });
      $('k-causes').innerHTML = fail < 0.005 ? '<div class="bt">No simulated mission failed</div>' : h;
      let dh = '<div class="bt">What drives the risk: points gained if one thing were known exactly</div>';
      r.drivers.forEach(([nm, v]) => { const gain = Math.round((v - r.p) * 100); dh += '<div class="br"><span>' + nm + '</span><span class="bb gain"><i style="width:' + Math.max(0, Math.min(100, (v - r.p) * 100)).toFixed(1) + '%"></i></span><span class="bv">' + (gain >= 2 ? '+' + gain : '0') + '</span></div>'; });
      $('k-drivers').innerHTML = dh;
      $('k-cap').textContent = 'Landing ' + fmtDT(tab.t0 + landingIndex() * HOUR) + '. The map is ' + fmtDist(2 * r.E) + ' across, in ' + fmtDist(r.sp) + ' cells, with the Moon\'s near side toward the top. Tap any point on it to aim there.';
    } else { $('k-pill').innerHTML = '<span class="pill big off">Simulating…</span>'; $('k-cap').textContent = ''; }
    if (!shown(cv)) return; cv.style.height = cv.clientWidth + 'px'; const { g, w } = prep(cv); g.fillStyle = '#0a0c11'; g.fillRect(0, 0, w, w);
    if (!r || !riskOk()) { g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = FONT(13); g.textAlign = 'center'; g.fillText(riskOk() ? 'Simulating…' : 'South-pole sites only', w / 2, w / 2); return; }
    if (!r.bg) {
      const B = 150, c = document.createElement('canvas'); c.width = c.height = B; const cg = c.getContext('2d'), im = cg.createImageData(B, B), H = new Float32Array(B * B), px = 2 * r.E / B;
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const x = r.x0 + (i + 0.5 - B / 2) * px, y = r.y0 + (B / 2 - (j + 0.5)) * px, rho = Math.hypot(x, y); H[j * B + i] = Terrain.elev(Math.max(-89.999, -90 + 2 * Math.atan(rho / (2 * RM)) * R2D), Math.atan2(x, y) * R2D); }
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const i1 = Math.min(B - 1, i + 1), i0 = Math.max(0, i - 1), j1 = Math.min(B - 1, j + 1), j0 = Math.max(0, j - 1); const sh = Math.max(0, Math.min(1, 0.5 - 1.3 * ((H[j * B + i1] - H[j * B + i0]) + (H[j1 * B + i] - H[j0 * B + i])) / ((i1 - i0) * px * 1000))); const o = (j * B + i) * 4, v = 30 + 150 * sh; im.data[o] = v; im.data[o + 1] = v; im.data[o + 2] = v + 6; im.data[o + 3] = 255; }
      cg.putImageData(im, 0, 0); r.bg = c;
    }
    g.imageSmoothingEnabled = true; g.drawImage(r.bg, 0, 0, w, w);
    const cwd = w / r.n; g.fillStyle = '#3fc78d';
    for (let iy = 0; iy < r.n; iy++) for (let ix = 0; ix < r.n; ix++) { const p = r.P[iy * r.n + ix]; if (p <= 0) continue; g.globalAlpha = (cur ? 0.72 : 0.3) * p; g.fillRect(ix * cwd, iy * cwd, cwd + 0.5, cwd + 0.5); }
    g.globalAlpha = 1; g.strokeStyle = 'rgba(240,116,98,0.9)'; g.lineWidth = 1;
    for (let iy = 0; iy < r.n; iy++) for (let ix = 0; ix < r.n; ix++) if (r.slope[iy * r.n + ix] > S.sig.slope) { const x = ix * cwd, y = iy * cwd; g.beginPath(); g.moveTo(x + 2, y + cwd - 2); g.lineTo(x + cwd - 2, y + 2); g.stroke(); }
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.arc(w / 2, w / 2, r.Rkm / (2 * r.E) * w, 0, 7); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(w / 2, w / 2, 4, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
    g.font = FONTC(13); g.textBaseline = 'middle'; const label = (t, x, y, left) => { const tw = g.measureText(t).width, lx = (left && x - 10 - tw > 4) || x + 10 + tw > w - 4 ? x - 10 - tw : x + 10; g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(t, lx, y); g.fillStyle = '#fff'; g.fillText(t, lx, y); };
    label('Aim', w / 2, w / 2 - 12);
    if (r.best.clear) { const bx = (r.best.ix + 0.5) * cwd, by = (r.best.iy + 0.5) * cwd; g.beginPath(); g.moveTo(bx, by - 7); g.lineTo(bx + 7, by); g.lineTo(bx, by + 7); g.lineTo(bx - 7, by); g.closePath(); g.fillStyle = '#3fc78d'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); label('Best aim ' + Math.round(r.best.p * 100) + '%', bx, by + (by < w / 2 ? -12 : 12), bx < w / 2); }
    const L = [0.1, 0.2, 0.5, 1, 2, 5, 10].reduce((a, b) => Math.abs(b - r.E / 2.5) < Math.abs(a - r.E / 2.5) ? b : a), lp = L / (2 * r.E) * w;
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(10, w - 12); g.lineTo(10 + lp, w - 12); g.stroke(); g.font = FONT(11); g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(fmtDist(L), 10, w - 22); g.fillStyle = '#fff'; g.fillText(fmtDist(L), 10, w - 22);
  }

  // ---------- plan: mission rescue ----------
  let rescueKey = '', rescue = null;
  function scopeSites() { return S.scope === 'cmp' ? rows() : S.scope === 'all' ? SITES : SITES.filter(s => s.lat <= -80); }
  function computeRescue() {
    const key = [cfgSig(), S.eye, S.plan.site.id, S.plan.site.lat, S.plan.t, S.slip, S.flex, S.scope, tab.t0, S.scope === 'cmp' ? rows().map(s => s.id).join() : ''].join('|');
    if (key === rescueKey) return rescue; rescueKey = key;
    const iP = idx(S.plan.t), iS = iP + S.slip * 24, need = S.cfg.days * 24;
    if (iP < 0 || iS + S.flex * 24 + need > tab.n) return (rescue = null);
    const pse = ser(S.plan.site), base = Ana.verdict(pse, iP, S.cfg), slipped = Ana.verdict(pse, iS, S.cfg);
    const list = scopeSites().slice(); if (!list.some(s => s.id === S.plan.site.id)) list.unshift(S.plan.site);
    const alts = list.map(site => {
      const se = ser(site); let best = null;
      for (let i = iS; i <= iS + S.flex * 24; i += 6) { const v = Ana.verdict(se, i, S.cfg); if (!best || v.state > best.v.state) best = { v, i }; if (v.state === 2) break; }
      let days = 0; for (let d = 0; d <= S.flex; d++) if (Ana.verdict(se, iS + d * 24, S.cfg).state > 0) days++;
      return { site, state: best.v.state, i: best.i, v: best.v, days, tier: Ana.siteMask(site, S.eye).tier };
    }).sort((a, b) => b.state - a.state || (a.state ? a.i - b.i : 0) || b.v.nom.minSoc - a.v.nom.minSoc);
    return (rescue = { iP, iS, base, slipped, alts });
  }
  function drawRescue() {
    $('r-slipv').textContent = S.slip + (S.slip === 1 ? ' day' : ' days');
    $('r-plan').textContent = 'Plan: ' + S.plan.site.name + ', landing ' + fmtDT(S.plan.t) + ', ' + S.cfg.days + '-day surface mission.';
    const r = computeRescue();
    if (!r) { $('r-cards').innerHTML = '<div class="card"><div class="s">The plan and its slip fall outside the loaded year, which starts on ' + fmtDate(tab.t0) + '. Move the clock to the plan date, or set a new plan.</div></div>'; $('r-tbl').innerHTML = ''; $('r-cap').textContent = ''; return; }
    const why = v => v.state === 2 ? 'Power and Earth contact hold for all ' + S.cfg.days + ' days, with the terrain margin.' : v.state === 1 ? 'Works on the modelled terrain; with the margin ' + v.rob.fails[0] + '.' : cap1(v.nom.fails.join(', and ')) + '.';
    const card = (k, t, v) => '<div class="card s' + v.state + '"><div class="k">' + k + '</div><div class="v">' + STN[v.state] + ' · ' + fmtDate(t) + '</div><div class="s">' + why(v) + '</div></div>';
    $('r-cards').innerHTML = card('As planned, ' + short(S.plan.site), S.plan.t, r.base) + card('After a ' + S.slip + '-day slip, same site', S.plan.t + S.slip * DAY, r.slipped);
    let h = '<thead><tr><th>#</th><th>Site</th><th>Land on</th><th>Extra wait</th><th>Verdict</th><th>Lowest battery</th><th>Longest link gap</th><th>Good landing days</th><th>Why</th></tr></thead><tbody>';
    r.alts.slice(0, 8).forEach((a, k) => {
      const t = tab.t0 + a.i * HOUR, wait = (a.i - r.iS) / 24;
      h += '<tr><td>' + (k + 1) + '</td><td><button type="button" data-open="' + a.site.id + '" data-t="' + t + '">' + short(a.site) + '</button></td><td>' + (a.state ? fmtDT(t).replace(' UTC', '') : '—') + '</td><td>' + (a.state ? (wait === 0 ? 'none' : '+' + (wait % 1 ? wait.toFixed(2) : wait) + ' d') : '—') + '</td><td><span class="st s' + a.state + '">' + STN[a.state] + '</span></td><td>' + Math.round(a.v.nom.minSoc * 100) + '%</td><td>' + fmtH(a.v.nom.maxGapH) + '</td><td>' + a.days + ' of ' + (S.flex + 1) + '</td><td>' + why(a.v) + '</td></tr>';
    });
    $('r-tbl').innerHTML = h + '</tbody>';
    const ok = r.alts.filter(a => a.state === 2).length, mg = r.alts.filter(a => a.state === 1).length;
    $('r-cap').textContent = 'Searched ' + r.alts.length + ' sites for landings between ' + fmtDate(S.plan.t + S.slip * DAY) + ' and ' + fmtDate(S.plan.t + (S.slip + S.flex) * DAY) + ', every 6 hours: ' + ok + ' meet the needs with the terrain margin, ' + mg + ' only without it. Ranked by verdict, then shortest extra wait, then battery margin. Select a site name to load that option.';
  }

  // ---------- explore: status ----------
  function drawStatus() {
    const c = S.cur, lit = c.sunClr > 0, link = c.earthClr > 0;
    const pills = [];
    pills.push(lit ? ['sun', c.sunFrac < 0.999 ? 'Sun partly visible' : 'Sunlit'] : (c.sunFrac > 0 ? ['warn', 'Sun mostly hidden'] : ['off', 'Dark']));
    pills.push(link ? ['earth', 'Earth line of sight'] : ['off', 'No Earth line of sight']);
    pills.push(lit && link ? ['go', 'Sun and Earth both visible'] : lit ? ['warn', 'Sun only'] : link ? ['warn', 'Earth only'] : ['off', 'Neither visible']);
    $('pills').innerHTML = pills.map(p => '<span class="pill ' + p[0] + '">' + p[1] + '</span>').join('');
    const se = S.ev.sun, ee = S.ev.earth;
    const horizonDays = Math.round((tab.t0 + tab.n * HOUR - S.t) / DAY);
    const sunTxt = lit ? 'The Sun is ' + Math.abs(c.sunClr).toFixed(2) + '° above the terrain to the ' + compass(c.sunAz) + ', with ' + Math.round(c.sunFrac * 100) + '% of its disc showing.'
      : 'The Sun is ' + Math.abs(c.sunClr).toFixed(2) + '° below the terrain horizon' + (c.sunFrac > 0 ? ', with ' + Math.round(c.sunFrac * 100) + '% of its disc still showing.' : '.');
    const earthTxt = link ? 'Earth is ' + Math.abs(c.earthClr).toFixed(2) + '° clear of the terrain.' : (c.earthEl < -c.earthRad ? 'Earth is below the horizon.' : 'Earth is hidden behind terrain.');
    $('say').textContent = sunTxt + ' ' + earthTxt;
    $('t-sun').textContent = sg(c.sunClr, 2); $('t-sun-s').textContent = 'Elevation ' + sg(c.sunEl, 2) + ' · bearing ' + c.sunAz.toFixed(0) + '° ' + compass(c.sunAz);
    $('t-earth').textContent = sg(c.earthClr, 2); $('t-earth-s').textContent = 'Elevation ' + sg(c.earthEl, 2) + ' · bearing ' + c.earthAz.toFixed(0) + '° ' + compass(c.earthAz);
    $('t-sset-k').textContent = lit ? 'Sunset in' : 'Sunrise in';
    $('t-sset').textContent = se ? fmtDur(se.t - S.t) : '> ' + horizonDays + ' d'; $('t-sset-s').textContent = se ? fmtDT(se.t) : (lit ? 'No sunset in the next ' + horizonDays + ' days' : 'No sunrise in the next ' + horizonDays + ' days');
    $('t-eset-k').textContent = link ? 'Earthset in' : 'Earthrise in';
    $('t-eset').textContent = ee ? fmtDur(ee.t - S.t) : (link ? 'Never sets' : 'Never rises'); $('t-eset-s').textContent = ee ? fmtDT(ee.t) : 'Within the next ' + horizonDays + ' days';
    const flat = c.sunFrac * Math.max(0, Math.sin(c.sunEl * D2R)), w = S.cfg.peakW * c.irr * (S.cfg.tracking ? c.sunFrac : flat);
    $('kv-power').textContent = 'Idealized index: sun-tracking array ' + Math.round(c.sunFrac * 100) + '%, horizontal array ' + Math.round(flat * 100) + '%. Your array would give about ' + Math.round(w) + ' W.';
    const dsn = Eng.dsnView(S.t).filter(d => d.el > 10).sort((a, b) => b.el - a.el);
    $('kv-los').textContent = link ? 'Yes, Earth\'s centre clears the terrain by ' + c.earthClr.toFixed(2) + '°.' : 'No.';
    $('kv-dsn').textContent = (dsn.length ? 'Moon is above 10° at ' + dsn.map(d => d.name + ' (' + d.el.toFixed(0) + '°)').join(', ') : 'Moon is below 10° at all three Deep Space Network complexes') + (link && dsn.length ? '. Geometry allows a pass.' : '.');
  }
  function drawSiteInfo() {
    const m = Ana.siteMask(S.site, S.eye);
    $('siteinfo').textContent = S.site.name + ' · ' + fmtLat(S.site.lat) + ', ' + fmtLon(S.site.lon) + ' · terrain height ' + (m.h0 >= 0 ? '+' : '−') + Math.abs(Math.round(m.h0)).toLocaleString('en-US') + ' m · ' + tierText(m) + ', from ' + sg(m.lo, 1) + ' to ' + sg(m.hi, 1) + '. ' + (S.site.note || '');
  }

  // ---------- explore: sky panorama ----------
  function skyRange(site) {
    const se = ser(site), m = Ana.siteMask(site, S.eye);
    let hi = m.hi; const a0 = idx(S.anchor), nW = S.span * 24;
    for (let i = a0; i < a0 + nW && i < tab.n; i += 2) { if (se.sunEl[i] > hi) hi = se.sunEl[i]; if (se.earthEl[i] > hi) hi = se.earthEl[i]; }
    const yMax = hi < 9 ? 10 : hi < 27 ? 30 : 90;
    return { yMin: Math.min(yMax === 90 ? -12 : yMax === 30 ? -6 : -4, Math.floor(m.lo) - 1), yMax };
  }
  // Paints one horizon panorama (terrain, Sun, Earth and their paths) for any site into a w x h box at the origin.
  function paintSky(g, w, h, site, c, range) {
    const padL = 34, padR = 8, padT = 10, padB = 22, pw = w - padL - padR, ph = h - padT - padB;
    const { yMin, yMax } = range || skyRange(site), m = Ana.siteMask(site, S.eye).mask;
    const X = az => padL + az / 360 * pw, Y = el => padT + (yMax - el) / (yMax - yMin) * ph;
    g.fillStyle = '#0a0c11'; g.fillRect(0, 0, w, h);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.fillStyle = 'rgba(255,255,255,0.5)'; for (let i = 0; i < 70; i++) { const x = padL + rnd() * pw, y = padT + rnd() * ph * 0.9, r = rnd() < 0.15 ? 1.1 : 0.6; g.fillRect(x, y, r, r); }
    g.font = FONT(11); g.textBaseline = 'middle'; g.textAlign = 'right';
    const stepY = yMax === 90 ? 15 : yMax === 30 ? 5 : 2;
    for (let e = Math.ceil(yMin / stepY) * stepY; e <= yMax; e += stepY) {
      g.strokeStyle = e === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)'; g.setLineDash(e === 0 ? [4, 4] : []);
      g.beginPath(); g.moveTo(padL, Y(e)); g.lineTo(w - padR, Y(e)); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText((e > 0 ? '+' : '') + e + '°', padL - 5, Y(e));
    }
    g.setLineDash([]); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]].forEach(([t, a]) => { g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText(t, Math.max(padL + 5, Math.min(w - padR - 5, X(a))), h - 7); g.strokeStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.moveTo(X(a), padT); g.lineTo(X(a), padT + ph); g.stroke(); });
    g.save(); g.beginPath(); g.rect(padL, padT, pw, ph); g.clip();
    const se = ser(site), x0 = (S.t - tab.t0) / HOUR, nT = Math.round(SYNODIC * 24);
    const i0 = Math.max(0, Math.ceil(x0)), i1 = Math.min(tab.n - 1, i0 + nT);
    function track(az, el, clr, col) {
      for (const vis of [false, true]) {
        g.strokeStyle = col; g.globalAlpha = vis ? 0.9 : 0.28; g.lineWidth = vis ? 1.6 : 1; g.setLineDash(vis ? [] : [2, 3]); g.beginPath();
        let pen = false;
        for (let i = i0; i <= i1; i++) {
          const ok = (clr[i] > 0) === vis && (i === i0 || Math.abs(az[i] - az[i - 1]) < 180);
          if (!ok) { pen = false; continue; }
          if (!pen) { if (i > i0 && Math.abs(az[i] - az[i - 1]) < 180) g.moveTo(X(az[i - 1]), Y(el[i - 1])); else g.moveTo(X(az[i]), Y(el[i])); pen = true; }
          g.lineTo(X(az[i]), Y(el[i]));
        }
        g.stroke();
      }
      g.setLineDash([]); g.globalAlpha = 1; g.fillStyle = col; g.font = FONT(10); g.textAlign = 'left';
      for (let d = 1, i = i0 + 24; i <= i1; i += 24, d++) {
        g.globalAlpha = clr[i] > 0 ? 0.95 : 0.4; g.beginPath(); g.arc(X(az[i]), Y(el[i]), 1.8, 0, 7); g.fill();
        if (d % 7 === 0 && d < 28) g.fillText('+' + d + 'd', X(az[i]) + 4, Y(el[i]) - 5);
      }
      g.globalAlpha = 1;
    }
    track(se.earthAz, se.earthEl, se.earthClr, '#62a0f2');
    track(se.sunAz, se.sunEl, se.sunClr, '#f0b03a');
    function body(az, el, kind, visible, clr) {
      const x = X(az), y = Math.max(padT + 6, Math.min(padT + ph - 6, Y(el)));
      if (kind === 'sun') {
        if (visible) { const gr = g.createRadialGradient(x, y, 2, x, y, 26); gr.addColorStop(0, 'rgba(255,214,120,0.85)'); gr.addColorStop(1, 'rgba(255,190,60,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 26, 0, 7); g.fill(); }
        g.fillStyle = visible ? '#fff3cf' : 'rgba(240,176,58,0.35)'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
        g.strokeStyle = '#f0b03a'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 6, 0, 7); g.stroke();
      } else {
        g.fillStyle = visible ? '#3f7fd8' : 'rgba(98,160,242,0.3)'; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
        if (visible) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.arc(x - 2, y - 2, 2.6, 0, 7); g.fill(); }
        g.strokeStyle = '#9cc4ff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, 7); g.stroke();
      }
      const mini = w < 520, lab = (kind === 'sun' ? 'Sun ' : 'Earth ') + Math.abs(clr).toFixed(1) + '° ' + (clr > 0 ? 'above' : 'below') + (mini ? '' : ' terrain'); g.font = FONTC(13); const tw = g.measureText(lab).width;
      const lx = x + 11 + tw > w - padR ? x - 11 - tw : x + 11; g.textAlign = 'left'; g.fillStyle = kind === 'sun' ? '#ffd98a' : '#b9d6ff';
      g.fillText(lab, lx, mini && kind === 'sun' ? Math.min(padT + ph - 8, y + 15) : Math.max(padT + 12, y - 9));   // in a small cell the Sun's label goes below it, so the two never collide
    }
    const M = a => Terrain.maskAt(m, a);
    const gr = g.createLinearGradient(0, Y(Math.min(yMax, 6)), 0, padT + ph); gr.addColorStop(0, 'rgba(126,121,113,0.96)'); gr.addColorStop(1, 'rgba(58,56,53,0.96)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(X(0), padT + ph + 2);
    for (let a = 0; a <= 360; a += 0.5) g.lineTo(X(a), Y(M(a)));
    g.lineTo(X(360), padT + ph + 2); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(214,208,196,0.9)'; g.lineWidth = 1; g.beginPath(); for (let a = 0; a <= 360; a += 0.5) { const x = X(a), y = Y(M(a)); a ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    body(c.earthAz, c.earthEl, 'earth', c.earthClr > 0, c.earthClr);
    body(c.sunAz, c.sunEl, 'sun', c.sunClr > 0, c.sunClr);
    g.restore();
  }
  function drawSky() {
    const cv = $('sky'); if (!shown(cv)) return; const { g, w, h } = prep(cv);
    paintSky(g, w, h, S.site, S.cur);
    $('skycap').textContent = Math.abs(S.site.lat) > 80
      ? 'A full turn of the horizon, with height above a level horizon on the vertical axis. Near the poles the Sun never climbs more than a degree or two, so one ridge decides whether a lander has power. Earth does not rise and set daily here: it drifts in a small loop as the Moon wobbles.'
      : 'A full turn of the horizon, with height above a level horizon on the vertical axis. Away from the poles the Sun crosses the sky once per lunar day, about two weeks of light then two weeks of night, while Earth stays almost fixed in the sky.';
  }

  // ---------- strips shared by timeline and compare ----------
  function strip(g, pred, i0, i1, x, y, w, h, col) {
    g.fillStyle = col; const n = i1 - i0; let s = -1;
    for (let i = i0; i <= i1; i++) {
      const on = i < i1 && pred(i);
      if (on && s < 0) s = i; if (!on && s >= 0) { const xa = x + (s - i0) / n * w, xb = x + (i - i0) / n * w; g.fillRect(xa, y, Math.max(0.6, xb - xa), h); s = -1; }
    }
  }
  function timeAxis(g, x, y, w, t0, span) {
    g.font = FONT(11); g.fillStyle = C.muted; g.textBaseline = 'top'; g.strokeStyle = C.line; g.lineWidth = 1;
    const ticks = [];
    if (span <= 30) for (let d = 0; d <= span; d += 5) ticks.push([t0 + d * DAY, fmtDM(t0 + d * DAY)]);
    else if (span <= 90) for (let d = 0; d <= span; d += 15) ticks.push([t0 + d * DAY, fmtDM(t0 + d * DAY)]);
    else { const d = new Date(t0); let yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1; for (let k = 0; k < 13; k++, mm++) { if (mm > 11) { mm = 0; yy++; } const t = Date.UTC(yy, mm, 1); if (t <= t0 + span * DAY) ticks.push([t, MON[mm] + (mm === 0 ? ' ’' + String(yy).slice(2) : '')]); } }
    let lastR = -1e9;
    ticks.forEach(([t, lab]) => {
      const px = x + (t - t0) / (span * DAY) * w; g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + 4); g.stroke();
      const tw = g.measureText(lab).width; let lx = px - tw / 2; lx = Math.max(x, Math.min(x + w - tw, lx));
      if (lx > lastR + 6) { g.textAlign = 'left'; g.fillText(lab, lx, y + 6); lastR = lx + tw; }
    });
  }
  function scrub(cv, padL, padR, setter) {
    let down = false;
    const at = e => { const r = cv.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left - padL) / (r.width - padL - padR))); setter(S.anchor + f * S.span * DAY); };
    cv.addEventListener('pointerdown', e => { down = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} at(e); });
    cv.addEventListener('pointermove', e => { if (down) at(e); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { down = false; }));
  }

  // ---------- explore: timeline ----------
  const TLP = { l: 46, r: 10 };
  function drawTimeline() {
    const cv = $('tl'); if (!shown(cv)) return; const { g, w, h } = prep(cv), se = ser(S.site);
    const a0 = idx(S.anchor), nW = S.span * 24, px = TLP.l, pw = w - TLP.l - TLP.r, top = 8, ch = h - 96, sy = top + ch + 10, st = nW > 3000 ? 2 : 1;
    let lim = 1; for (let i = 0; i <= nW; i += st) lim = Math.max(lim, Math.abs(se.sunClr[a0 + i]), Math.abs(se.earthClr[a0 + i]));
    lim = lim <= 4 ? Math.ceil(lim) : lim <= 12 ? Math.ceil(lim / 2) * 2 : lim <= 30 ? 30 : lim <= 60 ? 60 : 90;
    const X = i => px + i / nW * pw, Y = v => top + (lim - Math.max(-lim, Math.min(lim, v))) / (2 * lim) * ch;
    g.font = FONT(11); g.textBaseline = 'middle'; g.textAlign = 'right';
    const sv = lim <= 4 ? 1 : lim / 2;
    for (let v = -lim; v <= lim + 1e-9; v += sv) { g.strokeStyle = C.line; g.globalAlpha = v === 0 ? 1 : 0.5; g.beginPath(); g.moveTo(px, Y(v)); g.lineTo(px + pw, Y(v)); g.stroke(); g.globalAlpha = 1; g.fillStyle = C.muted; g.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '°', px - 6, Y(v)); }
    if (S.cfg.margin > 0) { g.fillStyle = C.muted; g.globalAlpha = 0.22; g.fillRect(px, Y(S.cfg.margin), pw, Math.max(1, Y(0) - Y(S.cfg.margin))); g.globalAlpha = 1; }
    g.strokeStyle = C.muted; g.lineWidth = 1.2; g.beginPath(); g.moveTo(px, Y(0)); g.lineTo(px + pw, Y(0)); g.stroke();
    function curve(a, col) {
      g.beginPath(); g.moveTo(X(0), Y(0)); for (let i = 0; i <= nW; i += st) g.lineTo(X(i), Y(Math.max(0, a[a0 + i]))); g.lineTo(X(nW), Y(0)); g.closePath(); g.fillStyle = col; g.globalAlpha = 0.16; g.fill(); g.globalAlpha = 1;
      g.beginPath(); for (let i = 0; i <= nW; i += st) { i ? g.lineTo(X(i), Y(a[a0 + i])) : g.moveTo(X(i), Y(a[a0 + i])); } g.strokeStyle = col; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    }
    curve(se.earthClr, C.earth); curve(se.sunClr, C.sun);
    [['Sun', C.sun, i => se.sunClr[i] > 0], ['Earth', C.earth, i => se.earthClr[i] > 0], ['Both', C.go, i => se.sunClr[i] > 0 && se.earthClr[i] > 0]].forEach(([t, col, pred], k) => {
      const y = sy + k * 16; g.fillStyle = C.cell; g.fillRect(px, y, pw, 11); strip(g, pred, a0, a0 + nW, px, y, pw, 11, col);
      g.fillStyle = C.muted; g.font = FONTC(12, 500); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(t.toUpperCase(), px - 6, y + 6);
    });
    timeAxis(g, px, sy + 48, pw, S.anchor, S.span);
    const cx = px + (S.t - S.anchor) / (S.span * DAY) * pw;
    g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, top - 2); g.lineTo(cx, sy + 45); g.stroke();
    g.fillStyle = C.ink; g.beginPath(); g.moveTo(cx - 5, top - 6); g.lineTo(cx + 5, top - 6); g.lineTo(cx, top + 2); g.closePath(); g.fill();
    const s = Ana.stats(se, a0, a0 + nW, 1, true);
    $('tlread').textContent = fmtDate(S.anchor) + ' to ' + fmtDate(S.anchor + S.span * DAY) + ': Sun up ' + s.litPct.toFixed(0) + '% of the time · Earth in view ' + s.linkPct.toFixed(0) + '% · both ' + s.bothPct.toFixed(0) + '% · longest night ' + s.maxDarkD.toFixed(1) + ' d · longest Earth gap ' + s.maxOutD.toFixed(1) + ' d';
  }

  // ---------- compare: the same instant at every site ----------
  function drawCmpSky() { const rs = rows(), rg = rs.map(skyRange); skyCells($('cmpsky'), rs, 190, null, { yMin: Math.min(...rg.map(r => r.yMin)), yMax: Math.max(...rg.map(r => r.yMax)) }); }   // one vertical scale, so the skies compare by eye
  function skyCells(cv, rs, ch, names, range) {
    if (!shown(cv)) return;
    const cw0 = cv.clientWidth, cols = Math.min(rs.length, cw0 >= 1100 ? 3 : cw0 >= 860 ? 2 : 1), gap = 10, nr = Math.ceil(rs.length / cols);
    cv.style.height = (nr * ch + (nr - 1) * gap) + 'px';
    const { g, w } = prep(cv), cw = (w - (cols - 1) * gap) / cols;
    rs.forEach((s, k) => {
      const x = (k % cols) * (cw + gap), y = Math.floor(k / cols) * (ch + gap), c = s === S.site ? S.cur : Ana.stateFrom(s, S.eye, S.now.sun, S.now.earth);
      g.save(); g.translate(x, y); g.beginPath(); g.roundRect ? g.roundRect(0, 0, cw, ch, 4) : g.rect(0, 0, cw, ch); g.clip();
      paintSky(g, cw, ch, s, c, range);
      const lit = c.sunClr > 0, link = c.earthClr > 0, st = lit && link ? ['POWER AND EARTH LINK', '#3fc78d'] : lit ? ['POWER, NO EARTH LINK', '#e8894a'] : link ? ['EARTH LINK, NO POWER', '#e8894a'] : ['NO POWER, NO EARTH LINK', '#f07462'];
      g.textBaseline = 'middle'; g.textAlign = 'left'; g.font = FONTC(15); g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)';
      const nm = (names ? names[k] : short(s)).toUpperCase(), nw = g.measureText(nm).width; g.strokeText(nm, 44, 22); g.fillStyle = '#fff'; g.fillText(nm, 44, 22);
      g.font = FONTC(12); const tw = g.measureText(st[0]).width, fits = 44 + nw + 16 + tw + 14 <= cw, sx = fits ? cw - tw - 14 : 44, sy = fits ? 22 : 40;   // on a narrow cell the status goes under the name
      g.strokeText(st[0], sx, sy); g.fillStyle = st[1]; g.fillText(st[0], sx, sy);
      g.restore();
    });
  }
  // ---------- learn: why the south pole is hard ----------
  let learnKey = '';
  function drawLearn() {
    const eq = byId('a11'), po = byId('shack');
    $('l-when').textContent = fmtDT(S.t); $('l-play').textContent = S.playing ? 'Pause' : 'Play a lunar month';
    skyCells($('learnsky'), [eq, po], 240, ['Apollo 11 · near the equator', 'Shackleton rim · 7 km from the south pole']);
    const key = tab.t0 + '|' + S.eye;
    if (key !== learnKey) {             // facts from the whole loaded year, for both sites
      learnKey = key;
      const fact = site => { const se = ser(site), st = Ana.stats(se, 0, tab.n, 1, true); let hi = -90, eh = -90; for (let i = 0; i < tab.n; i++) { if (se.sunEl[i] > hi) hi = se.sunEl[i]; if (se.earthEl[i] > eh) eh = se.earthEl[i]; } return { hi, eh, st }; };
      const a = fact(eq), b = fact(po), days = Math.round(tab.n / 24);
      const tile = (k, va, vb, note) => '<div class="tile"><div class="k">' + k + '</div><div class="duo"><div><span>Apollo 11</span><b>' + va + '</b></div><div><span>Shackleton rim</span><b>' + vb + '</b></div></div><div class="s">' + note + '</div></div>';
      $('l-tiles').innerHTML = tile('Highest the Sun climbs', a.hi.toFixed(0) + '°', b.hi.toFixed(1) + '°', 'Near the pole sunlight arrives almost sideways, so a single hill can block it.')
        + tile('Longest night', a.st.maxDarkD.toFixed(1) + ' d', b.st.maxDarkD.toFixed(1) + ' d', 'A high polar ridge has short nights. A crater floor beside it may never see the Sun at all.')
        + tile('Time with Earth in view', a.st.linkPct.toFixed(0) + '%', b.st.linkPct.toFixed(0) + '%', 'From the near side Earth never sets. At the pole it bobs above and below the terrain about every 27 days.');
      $('l-facts').textContent = 'Figures cover the ' + days + ' days from ' + fmtDate(tab.t0) + ', measured against the real terrain at each site.';
    }
    const cv = $('tilt'); if (!shown(cv)) return; const { g, w, h } = prep(cv), two = w >= 620, pw = two ? w / 2 : w, ph = two ? h : h / 2;
    [['Earth', 23.44, '#4f8fe6', '#17325c', 'At midsummer the Sun stands 23.4° above the horizon at the pole.'], ['Moon', 1.54, '#d8d6cc', '#3a3d45', 'The Sun never rises more than about 1.5° above a level horizon at the pole.']].forEach(([name, tilt, lit, dark, note], k) => {
      const ox = two ? k * pw : 0, oy = two ? 0 : k * ph, cx = ox + pw * 0.56, cy = oy + ph * 0.46, r = Math.min(pw * 0.2, ph * 0.3), a = tilt * D2R;
      g.strokeStyle = C.sun; g.fillStyle = C.sun; g.lineWidth = 1.5; g.globalAlpha = 0.7;
      for (let i = -2; i <= 2; i++) { const y = cy + i * r * 0.5, x0 = ox + 16, x1 = cx - r - 26; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.beginPath(); g.moveTo(x1 + 7, y); g.lineTo(x1, y - 4); g.lineTo(x1, y + 4); g.closePath(); g.fill(); }
      g.globalAlpha = 1; g.font = FONTC(12, 500); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText('SUNLIGHT', ox + 16, cy - r * 1.0 - 12);
      g.fillStyle = dark; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.fillStyle = lit; g.beginPath(); g.arc(cx, cy, r, Math.PI / 2, 3 * Math.PI / 2); g.closePath(); g.fill();
      const sx = -Math.sin(a), sy = Math.cos(a);                    // centre to south pole: leaning toward the Sun by the tilt
      g.strokeStyle = C.muted; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx, cy - r * 1.3); g.lineTo(cx, cy + r * 1.3); g.stroke(); g.setLineDash([]);
      g.strokeStyle = C.ink; g.lineWidth = 1.8; g.beginPath(); g.moveTo(cx - sx * r * 1.3, cy - sy * r * 1.3); g.lineTo(cx + sx * r * 1.3, cy + sy * r * 1.3); g.stroke();
      const px = cx + sx * r, py = cy + sy * r; g.strokeStyle = C.muted; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px - sy * 34, py + sx * 34); g.lineTo(px + sy * 34, py - sx * 34); g.stroke();   // the pole's level horizon
      g.fillStyle = C.bad; g.beginPath(); g.arc(px, py, 4.5, 0, 7); g.fill();
      g.fillStyle = C.ink; g.font = FONTC(17); g.textAlign = 'center'; g.fillText(name.toUpperCase() + ' · AXIS TILT ' + tilt.toFixed(1) + '°', ox + pw / 2, oy + 20);
      g.font = FONTC(12, 500); g.fillStyle = C.bad; g.textAlign = 'right'; g.fillText('SOUTH POLE', px - 12, py + 18);
      g.font = FONT(13); g.fillStyle = C.muted; g.textAlign = 'center'; g.fillText(note, ox + pw / 2, oy + ph - 10, pw - 20);
    });
  }
  // ---------- compare ----------
  function drawCompare() {
    const cv = $('cmp'); if (!shown(cv)) return;
    const rs = rows(), a0 = idx(S.anchor), nW = S.span * 24;
    $('chips').innerHTML = rs.map((s, i) => '<span class="chip' + (i === 0 ? ' pin' : '') + '">' + s.name + (i === 0 ? '' : '<button type="button" data-rm="' + s.id + '" aria-label="Remove ' + s.name + '">×</button>') + '</span>').join('');
    const st = rs.map(s => Ana.stats(ser(s), a0, a0 + nW, 1, true));
    const cols = [['Sunlit', 'litPct', 1, v => v.toFixed(0) + '%'], ['Earth in view', 'linkPct', 1, v => v.toFixed(0) + '%'], ['Both', 'bothPct', 1, v => v.toFixed(0) + '%'],
      ['Longest sunlit run', 'maxLitD', 1, v => v.toFixed(1) + ' d'], ['Longest night', 'maxDarkD', -1, v => v.toFixed(1) + ' d'], ['Longest Earth gap', 'maxOutD', -1, v => v.toFixed(1) + ' d'], ['Mean solar availability', 'pTrack', 1, v => v.toFixed(0) + '%']];
    let html = '<thead><tr><th>Site</th>' + cols.map(c => '<th>' + c[0] + '</th>').join('') + '<th>Landing days that meet the needs, next 12 months</th><th>Terrain</th></tr></thead><tbody>';
    const good = rs.map(s => { let n = 0; for (const v of calStates(s)) if (v === 2) n++; return n; });
    rs.forEach((s, i) => {
      html += '<tr><td>' + s.name + '</td>' + cols.map(c => { const vals = st.map(x => x[c[1]] * c[2]), best = Math.max(...vals); return '<td' + (rs.length > 1 && vals[i] === best ? ' class="best"' : '') + '>' + c[3](st[i][c[1]]) + '</td>'; }).join('')
        + '<td' + (rs.length > 1 && good[i] === Math.max(...good) ? ' class="best"' : '') + '>' + good[i] + '</td><td>' + Ana.siteMask(s, S.eye).tier.slice(5) + '</td></tr>';
    });
    $('cmptbl').innerHTML = html + '</tbody>';
    const rowH = 52; cv.style.height = (rs.length * rowH + 26) + 'px';
    const { g, w } = prep(cv), px = 8, pw = w - 16;
    rs.forEach((s, r) => {
      const se = ser(s), y = r * rowH;
      g.font = FONTC(13); g.fillStyle = C.ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(s.name.toUpperCase(), px, y + 14);
      [[C.sun, i => se.sunClr[i] > 0], [C.earth, i => se.earthClr[i] > 0], [C.go, i => se.sunClr[i] > 0 && se.earthClr[i] > 0]].forEach(([col, pred], k) => {
        const yy = y + 20 + k * 9; g.fillStyle = C.cell; g.fillRect(px, yy, pw, 7); strip(g, pred, a0, a0 + nW, px, yy, pw, 7, col);
      });
    });
    const yb = rs.length * rowH; timeAxis(g, px, yb + 2, pw, S.anchor, S.span);
    const cx = px + (S.t - S.anchor) / (S.span * DAY) * pw; g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, yb); g.stroke();
  }

  // ---------- compare: landing-date calendar ----------
  const CALP = { l: 8, r: 8 }; let calHover = null;
  function drawCalendar() {
    const cv = $('cal'); if (!shown(cv)) return;
    const rs = rows(), rowH = 44; cv.style.height = (rs.length * rowH + 26) + 'px';
    const { g, w } = prep(cv), px = CALP.l, pw = w - CALP.l - CALP.r, nd = 366, cw = pw / nd;
    rs.forEach((s, r) => {
      const st = calStates(s), y = r * rowH;
      g.font = FONTC(13); g.fillStyle = C.ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(s.name.toUpperCase(), px, y + 14);
      g.fillStyle = C.cell; g.fillRect(px, y + 20, pw, 18);
      for (let d = 0; d < nd; d++) { if (!st[d]) continue; g.fillStyle = st[d] === 2 ? C.go : C.warn; g.fillRect(px + d * cw, y + 20, cw + 0.4, 18); }
    });
    const yb = rs.length * rowH; timeAxis(g, px, yb + 2, pw, S.calAnchor, nd);
    const x = px + (S.t - S.calAnchor) / (nd * DAY) * pw; if (x >= px && x <= px + pw) { g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 16); g.lineTo(x, yb - 2); g.stroke(); }
    const d = calHover != null ? calHover : Math.floor((S.t - S.calAnchor) / DAY);
    if (d >= 0 && d < nd) $('calread').textContent = 'Land on ' + fmtDate(S.calAnchor + d * DAY) + ' for ' + S.cfg.days + ' days: ' + rs.map(s => { const v = Ana.verdict(ser(s), d * 24, S.cfg); return short(s) + ' ' + (v.state === 2 ? 'passes' : v.state === 1 ? 'is marginal' : 'fails, ' + v.nom.fails[0]); }).join(' · ') + '.';
  }

  // ---------- maps ----------
  const PS = 400, CAP = -80, RHO = 2 * RM * Math.tan((90 + CAP) / 2 * D2R), PXKM = 2 * RHO / PS;
  const pH = new Float32Array(PS * PS), pSL = new Float32Array(PS * PS), pCL = new Float32Array(PS * PS), pSO = new Float32Array(PS * PS), pCO = new Float32Array(PS * PS), pIn = new Uint8Array(PS * PS), pHill = new Float32Array(PS * PS);
  const pFrac = new Float32Array(PS * PS), pInc = new Float32Array(PS * PS), sunF = new Float32Array(PS * PS), sunI = new Float32Array(PS * PS); let sunFt = NaN;
  const STEPS = []; for (let d = 1; d <= 8; d++) STEPS.push(d); for (let d = 9; d < 190; d *= 1.12) STEPS.push(d);
  const off = document.createElement('canvas'); off.width = off.height = PS; const offg = off.getContext('2d'); const img = offg.createImageData(PS, PS);
  function buildPolar() {
    for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
      const i = y * PS + x, Xk = (x + 0.5 - PS / 2) * PXKM, Yk = (PS / 2 - (y + 0.5)) * PXKM, rho = Math.hypot(Xk, Yk);
      const lat = -90 + 2 * Math.atan(rho / (2 * RM)) * R2D, lon = Math.atan2(Xk, Yk);
      pH[i] = Terrain.elev(lat, lon * R2D); pSL[i] = Math.sin(lat * D2R); pCL[i] = Math.cos(lat * D2R); pSO[i] = Math.sin(lon); pCO[i] = Math.cos(lon); pIn[i] = rho <= RHO ? 1 : 0;
    }
    for (let y = 1; y < PS - 1; y++) for (let x = 1; x < PS - 1; x++) {
      const i = y * PS + x, gx = (pH[i + 1] - pH[i - 1]) / (2 * PXKM * 1000), gy = (pH[i + PS] - pH[i - PS]) / (2 * PXKM * 1000);
      pHill[i] = Math.max(0, Math.min(1, 0.5 - 1.8 * (gx + gy)));
    }
  }
  function castPolar(vec, finite, rad, pFrac, pInc) {
    let ux = 0, uy = 0, uz = 0;
    if (!finite) { const L = Math.hypot(vec[0], vec[1], vec[2]); ux = vec[0] / L; uy = vec[1] / L; uz = vec[2] / L; }
    for (let i = 0; i < PS * PS; i++) {
      if (!pIn[i]) continue;
      const sl = pSL[i], cl = pCL[i], so = pSO[i], co = pCO[i], nx = cl * co, ny = cl * so, nz = sl;
      if (finite) { const vx = vec[0] - RM * nx, vy = vec[1] - RM * ny, vz = vec[2] - RM * nz, L = Math.hypot(vx, vy, vz); ux = vx / L; uy = vy / L; uz = vz / L; }
      const el = Math.asin(ux * nx + uy * ny + uz * nz) * R2D;
      if (el < -rad - 7) { pFrac[i] = 0; pInc[i] = 0; continue; }
      const sN = -ux * sl * co - uy * sl * so + uz * cl, sE = -ux * so + uy * co;
      let dx = sN * so + sE * co, dy = -(sN * co - sE * so); const L2 = Math.hypot(dx, dy) || 1; dx /= L2; dy /= L2;
      const x = i % PS, y = (i / PS) | 0, h1 = pH[i], tanTop = Math.tan((el + rad) * D2R); let mt = -0.15;
      for (let k = 0; k < STEPS.length; k++) {
        const d = STEPS[k], xx = Math.round(x + dx * d), yy = Math.round(y + dy * d); if (xx < 0 || yy < 0 || xx >= PS || yy >= PS) break;
        const dk = d * PXKM, tA = (pH[yy * PS + xx] - h1) / (dk * 1000) - dk / (2 * RM); if (tA > mt) { mt = tA; if (mt > tanTop) break; }
      }
      pFrac[i] = Eng.discFrac(el, rad, Math.atan(mt) * R2D);
      const xa = Math.max(0, Math.min(PS - 1, Math.round(x + dx * 1.5))), ya = Math.max(0, Math.min(PS - 1, Math.round(y + dy * 1.5))), xb = Math.max(0, Math.min(PS - 1, Math.round(x - dx * 1.5))), yb = Math.max(0, Math.min(PS - 1, Math.round(y - dy * 1.5)));
      const gsl = (pH[ya * PS + xa] - pH[yb * PS + xb]) / (3 * PXKM * 1000);
      pInc[i] = Math.max(0, Math.sin((el + Math.atan(gsl) * R2D) * D2R));
    }
  }
  function sunRaster() { if (sunFt !== S.t) { castPolar(S.now.sun, false, 0.266, sunF, sunI); sunFt = S.t; } }

  // ---------- explore: first-person surface view ----------
  // A column-by-column terrain renderer: for each screen column (one compass direction) it walks outward from the site,
  // converts each piece of ground to a viewing angle (with the Moon's curvature) and paints what is not hidden by nearer ground.
  const VW = { az: null, fov: 90, off: document.createElement('canvas'), lit: new Float32Array(128 * 128), litKey: '' };
  const wrap180 = a => ((a + 540) % 360) - 180;
  function drawSurface() {
    const cv = $('surf'); if (!shown(cv)) return;
    cv.style.height = (riskOk() ? Math.round(Math.max(190, Math.min(540, cv.clientWidth * (cv.clientWidth < 520 ? 0.62 : 0.37)))) : 96) + 'px';   // only a short notice when there is no fine terrain to draw
    const { g, w, h } = prep(cv); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    if (!riskOk()) { g.fillStyle = 'rgba(255,255,255,0.65)'; g.font = FONT(13); g.textAlign = 'center'; g.fillText('The surface view needs the fine terrain, which covers 80°S to the south pole.', w / 2, h / 2); $('surfcap').textContent = 'Pick a south-pole site to stand on the surface. The chart below shows the sky for any site.'; return; }
    const c = S.cur, m = Ana.siteMask(S.site, S.eye), mask = m.mask;
    if (VW.az === null) { const sepA = wrap180(c.earthAz - c.sunAz); VW.az = Math.abs(sepA) <= 0.86 * VW.fov ? c.sunAz + sepA / 2 : c.sunAz + VW.fov * 0.24; }   // both bodies in frame when they fit; otherwise the Sun off to one side
    const fast = S.playing || VW.drag, Wc = Math.min(fast ? 400 : 900, Math.round(w)), grow = fast ? 0.025 : 0.013, Hc = Math.round(Wc * h / w), fovH = VW.fov, fovV = fovH * Hc / Wc, elC = -0.02 * fovV;
    const lam = S.site.lon * D2R, nx = Math.sin(lam), ny = Math.cos(lam), ex = Math.cos(lam), ey = -Math.sin(lam);
    const rho0 = 2 * RM * Math.tan((90 + Math.max(-89.999, S.site.lat)) / 2 * D2R), x0 = rho0 * nx, y0 = rho0 * ny, hEye = m.h0 + S.eye;
    const sa = c.sunAz * D2R, ux = nx * Math.cos(sa) + ex * Math.sin(sa), uy = ny * Math.cos(sa) + ey * Math.sin(sa), E = Terrain.elevXYsmooth, EB = Terrain.elevXY;
    // cast shadows near the site: is each 200 m cell in sunlight?
    const NL = 128, LS = 0.2, key = [S.site.lat, S.site.lon, S.t].join('|');
    if (VW.litKey !== key) {
      VW.litKey = key; sunRaster();
      for (let j = 0; j < NL; j++) for (let i = 0; i < NL; i++) {
        const x = x0 + (i - NL / 2 + 0.5) * LS, y = y0 + (NL / 2 - j - 0.5) * LS, h1 = EB(x, y), el = c.sunEl + ((x - x0) * ux + (y - y0) * uy) / RM * R2D; let mt = -0.2;
        for (let t = 0.08; t < 160; t += Math.max(0.08, t * 0.09)) { const v = (EB(x + ux * t, y + uy * t) - h1) / (1000 * t) - t / (2 * RM); if (v > mt) mt = v; }
        VW.lit[j * NL + i] = Eng.discFrac(el, 0.266, Math.atan(mt) * R2D);
      }
    }
    const litAt = (x, y) => {
      const i = (x - x0) / LS + NL / 2 - 0.5, j = NL / 2 - 0.5 - (y - y0) / LS;
      if (i >= 0 && j >= 0 && i < NL - 1 && j < NL - 1) { const i0 = i | 0, j0 = j | 0, fi = i - i0, fj = j - j0, a = VW.lit, k = j0 * NL + i0; return (a[k] * (1 - fi) + a[k + 1] * fi) * (1 - fj) + (a[k + NL] * (1 - fi) + a[k + NL + 1] * fi) * fj; }
      const px = Math.floor(x / PXKM + PS / 2), py = Math.floor(PS / 2 - y / PXKM); return px >= 0 && py >= 0 && px < PS && py < PS ? sunF[py * PS + px] : 1;
    };
    const off = VW.off; if (off.width !== Wc || off.height !== Hc) { off.width = Wc; off.height = Hc; }
    const og = off.getContext('2d'), im = og.createImageData(Wc, Hc), buf = new Uint32Array(im.data.buffer);
    const Y = el => (0.5 - (el - elC) / fovV) * Hc, expo = 1 / (6 * Math.sin(Math.max(0.6, c.sunEl) * D2R));   // exposure: level sunlit ground reads mid-grey
    for (let col = 0; col < Wc; col++) {
      const az = VW.az + ((col + 0.5) / Wc - 0.5) * fovH, a = az * D2R, dx = nx * Math.cos(a) + ex * Math.sin(a), dy = ny * Math.cos(a) + ey * Math.sin(a), toSun = Math.cos(a - sa);
      let yb = Hc, last = 0xff0a0a0a, pr = -1, pf = 0, pc = 0;        // pr/pf/pc: the partly covered top pixel of the nearest span so far
      const mix = (c1, c2, f) => 0xff000000 | (((c1 >> 16 & 255) * f + (c2 >> 16 & 255) * (1 - f)) << 16) | (((c1 >> 8 & 255) * f + (c2 >> 8 & 255) * (1 - f)) << 8) | ((c1 & 255) * f + (c2 & 255) * (1 - f));
      for (let d = 0.004 * (1 + grow * ((col * 7919) % 13) / 13); d < 300 && yb > 0; d += Math.max(0.002, d * grow)) {
        const x = x0 + dx * d, y = y0 + dy * d, hh = E(x, y), pyF = Y(Math.atan((hh - hEye) / (1000 * d) - d / (2 * RM)) * R2D), py = Math.floor(pyF);
        if (py >= yb) continue;
        const dl = Math.max(0.03, d * 0.01), gx = (E(x + dl, y) - E(x - dl, y)) / (2000 * dl), gy = (E(x, y + dl) - E(x, y - dl)) / (2000 * dl);
        const elL = (c.sunEl + d / RM * toSun * R2D) * D2R, ch = Math.cos(elL), lam2 = Math.max(0, (-gx * ux * ch - gy * uy * ch + Math.sin(elL)) / Math.sqrt(1 + gx * gx + gy * gy));
        const q = litAt(x, y) * lam2 * expo * 1.7, v = (6 + 249 * Math.pow(q / (1 + q), 0.72)) | 0;      // soft tone curve, no hard clipping
        last = 0xff000000 | ((v * 0.9) << 16) | ((v * 0.96) << 8) | v;       // ABGR: slightly warm grey
        if (pr >= 0) buf[pr * Wc + col] = mix(pc, last, pf);                // the farther ground shows through the nearer span's edge pixel
        for (let r = Math.max(0, py + 1); r < yb; r++) buf[r * Wc + col] = last;
        if (py >= 0) { buf[py * Wc + col] = last; pr = py; pf = py + 1 - pyF; pc = last; } else pr = -1;
        yb = py;
      }
      // make the painted skyline agree exactly with the horizon used for every number on this page
      const ymF = Math.max(0, Math.min(Hc, Y(Terrain.maskAt(mask, az)))), ym = Math.floor(ymF);
      if (yb > ym) for (let r = ym; r < Math.min(Hc, yb); r++) buf[r * Wc + col] = last; else for (let r = Math.max(0, yb); r < ym; r++) buf[r * Wc + col] = 0;
      if (ym >= 0 && ym < Hc) buf[ym * Wc + col] = (buf[ym * Wc + col] & 0x00ffffff) | (Math.round(255 * (ym + 1 - ymF)) << 24);   // soft edge against the sky
    }
    og.putImageData(im, 0, 0);
    const X = az => (wrap180(az - VW.az) / fovH + 0.5) * w, Yc = el => (0.5 - (el - elC) / fovV) * h, ppd = w / fovH;
    // Earth, with its phase, then the Sun; the terrain is painted over them
    const sep = Math.acos(Math.max(-1, Math.min(1, Math.sin(c.sunEl * D2R) * Math.sin(c.earthEl * D2R) + Math.cos(c.sunEl * D2R) * Math.cos(c.earthEl * D2R) * Math.cos((c.sunAz - c.earthAz) * D2R)))), k = (1 - Math.cos(sep)) / 2;
    const exs = X(c.earthAz), eys = Yc(c.earthEl), re = Math.max(3, c.earthRad * ppd), sxs = X(c.sunAz), sys = Yc(c.sunEl), rs = Math.max(1.6, c.sunRad * ppd);
    g.save(); g.translate(exs, eys); g.rotate(Math.atan2(-(c.sunEl - c.earthEl), wrap180(c.sunAz - c.earthAz) * Math.cos(c.earthEl * D2R)));
    g.fillStyle = '#0d1f3d'; g.beginPath(); g.arc(0, 0, re, 0, 7); g.fill();
    g.fillStyle = '#5b9cf0'; g.beginPath(); g.arc(0, 0, re, -Math.PI / 2, Math.PI / 2, false); g.ellipse(0, 0, Math.abs(1 - 2 * k) * re, re, 0, Math.PI / 2, -Math.PI / 2, k < 0.5); g.closePath(); g.fill(); g.restore();
    const gl = g.createRadialGradient(sxs, sys, rs, sxs, sys, Math.max(26, rs * 7)); gl.addColorStop(0, 'rgba(255,240,205,0.9)'); gl.addColorStop(0.25, 'rgba(255,225,160,0.28)'); gl.addColorStop(1, 'rgba(255,220,150,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(sxs, sys, Math.max(26, rs * 7), 0, 7); g.fill(); g.fillStyle = '#fffaf0'; g.beginPath(); g.arc(sxs, sys, rs, 0, 7); g.fill();
    g.imageSmoothingEnabled = true; g.drawImage(off, 0, 0, w, h);
    // labels and scales
    g.font = FONTC(13); g.textBaseline = 'middle';
    const tag = (t, x, y, col, hidden, r) => {
      if (x < -20 || x > w + 20) return; if (hidden) { g.setLineDash([3, 3]); g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, Math.max(6, r), 0, 7); g.stroke(); g.setLineDash([]); }
      const tw = g.measureText(t).width, lx = x + r + 8 + tw > w - 4 ? x - r - 8 - tw : x + r + 8, ly = Math.max(10, Math.min(h - 26, y - r - 6)); g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(t, lx, ly); g.fillStyle = col; g.fillText(t, lx, ly);
    };
    tag(c.earthClr > 0 ? 'Earth' : 'Earth, behind the terrain', exs, eys, '#b9d6ff', c.earthClr <= 0, re);
    tag(c.sunClr > 0 ? 'Sun' : 'Sun, behind the terrain', sxs, sys, '#ffd98a', c.sunClr <= 0, rs);
    g.font = FONT(10); g.fillStyle = 'rgba(255,255,255,0.75)'; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const stepA = fovH > 70 ? 15 : fovH > 40 ? 10 : 5;
    for (let a = Math.ceil((VW.az - fovH / 2) / stepA) * stepA; a <= VW.az + fovH / 2; a += stepA) { const x = (a - VW.az) / fovH * w + w / 2, aa = ((a % 360) + 360) % 360; g.beginPath(); g.moveTo(x, h - 4); g.lineTo(x, h - 9); g.stroke(); g.fillText(aa % 90 === 0 ? ['N', 'E', 'S', 'W'][aa / 90] : aa + '°', Math.max(12, Math.min(w - 12, x)), h - 12); }
    g.textAlign = 'left'; g.textBaseline = 'middle'; const stepE = fovV > 30 ? 5 : fovV > 12 ? 2 : 1;
    for (let e = Math.ceil((elC - fovV / 2) / stepE) * stepE; e <= elC + fovV / 2; e += stepE) { const y = Yc(e); if (y < 10 || y > h - 26) continue; g.beginPath(); g.moveTo(0, y); g.lineTo(5, y); g.stroke(); g.fillText((e > 0 ? '+' : e < 0 ? '−' : '') + Math.abs(e) + '°', 8, y); }
    if (w >= 560 && S.ev) {
      const line = (name, clr, ev) => name + ' ' + Math.abs(clr).toFixed(2) + '° ' + (clr > 0 ? 'above' : 'below') + ' the terrain · ' + (ev ? (clr > 0 ? 'sets in ' : 'rises in ') + fmtDur(ev.t - S.t) : (clr > 0 ? 'stays up for the loaded year' : 'stays down for the loaded year'));
      const rowsH = [[line('Sun', c.sunClr, S.ev.sun), c.sunClr > 0 ? '#ffd98a' : 'rgba(255,217,138,0.55)'], [line('Earth', c.earthClr, S.ev.earth), c.earthClr > 0 ? '#b9d6ff' : 'rgba(185,214,255,0.55)']];
      const both = c.sunClr > 0 && c.earthClr > 0, head = both ? 'POWER AND EARTH LINK' : c.sunClr > 0 ? 'POWER, NO EARTH LINK' : c.earthClr > 0 ? 'EARTH LINK, NO POWER' : 'NO POWER, NO EARTH LINK';
      g.font = FONT(13); const bw = Math.max(g.measureText(rowsH[0][0]).width, g.measureText(rowsH[1][0]).width) + 44, bh = 74, bx = w - bw - 12, by = 12;
      g.fillStyle = 'rgba(8,10,14,0.72)'; g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1; g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, bh, 6) : g.rect(bx, by, bw, bh); g.fill(); g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = FONTC(13); g.fillStyle = both ? '#3fc78d' : '#e8894a'; g.fillText(head, bx + 14, by + 16);
      g.font = FONT(13); rowsH.forEach(([t, col], k) => { const y = by + 38 + k * 20; g.fillStyle = col; g.beginPath(); g.arc(bx + 19, y, 4.5, 0, 7); g.fill(); g.fillText(t, bx + 32, y); });
    }
    $('surfcap').textContent = 'The view from ' + S.eye + ' m above the ground at ' + short(S.site) + ', ' + fmtDT(S.t) + ', ' + Math.round(fovH) + '° wide. Terrain and shadows come from NASA\'s LOLA height map; the Sun and Earth are drawn at their true sizes and nothing is stretched. There is no air, so far hills look as sharp as near ones. Drag sideways to look around.';
  }
  function polarXY(lat, lon, R, cx, cy) { const rho = 2 * RM * Math.tan((90 + lat) / 2 * D2R) / RHO * R; return [cx + rho * Math.sin(lon * D2R), cy - rho * Math.cos(lon * D2R)]; }
  let mapGeom = null;
  function glyph(g, x, y, kind) {
    if (kind === 'sun') { g.fillStyle = '#ffe2a0'; g.strokeStyle = '#f0b03a'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.stroke(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); g.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); g.stroke(); } }
    else { g.fillStyle = '#3f7fd8'; g.strokeStyle = '#b9d6ff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); g.stroke(); g.beginPath(); g.moveTo(x - 7, y); g.lineTo(x + 7, y); g.moveTo(x, y - 7); g.lineTo(x, y + 7); g.lineWidth = 1; g.stroke(); }
  }
  function markers(g, proj, filt) {
    const rs = rows().map(s => s.id), hits = [];
    const list = SITES.filter(filt); if (S.site.id === 'custom' && filt(S.site)) list.push(S.site);
    list.forEach(s => {
      const [x, y] = proj(s.lat, s.lon), sel = s.id === S.site.id, cmp = rs.includes(s.id);
      hits.push({ x, y, s });
      g.beginPath(); g.arc(x, y, sel ? 5 : 3, 0, 7); g.fillStyle = sel ? '#fff' : cmp ? '#3fc78d' : 'rgba(255,255,255,0.75)'; g.fill(); g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 1; g.stroke();
      if (sel) { g.beginPath(); g.arc(x, y, 10, 0, 7); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    });
    g.font = FONTC(13); g.textBaseline = 'middle';
    const boxes = [];
    list.filter(s => s.id === S.site.id || rs.includes(s.id)).sort((a, b) => (b.id === S.site.id) - (a.id === S.site.id)).forEach(s => {
      const [x, y] = proj(s.lat, s.lon), t = short(s), tw = g.measureText(t).width;
      let bx = 0, by = 0;
      for (const [sx, sy] of [[1, 0], [-1, 0], [1, -15], [-1, -15], [1, 15], [-1, 15], [1, -30], [1, 30]]) {
        bx = sx > 0 ? x + 13 : x - 13 - tw; by = Math.max(9, Math.min(mapGeom.h - 9, y + sy));
        if (bx < 3 || bx + tw > mapGeom.w - 3) continue;
        if (!boxes.some(b => bx < b[0] + b[2] + 4 && bx + tw + 4 > b[0] && Math.abs(by - b[1]) < 14)) break;
      }
      boxes.push([bx, by, tw]);
      g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(t, bx, by); g.fillStyle = '#fff'; g.fillText(t, bx, by);
    });
    return hits;
  }
  let texImg = null, nightCv = null;
  // ---------- explore: 3D globe ----------
  // An orthographic view of the whole Moon: every pixel on the disc is turned back into a latitude and longitude,
  // coloured from the Moon mosaic and lit from the true Sun direction, so the day and night line is the real one.
  const GL = { lat: -30, lon: 0, tex: null, tw: 0, th: 0, off: document.createElement('canvas'), drag: false, moved: false };
  function globeBasis() {
    const la = GL.lat * D2R, lo = GL.lon * D2R, cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    return { F: [cl * co, cl * so, sl], Rt: [-so, co, 0], U: [-sl * co, -sl * so, cl] };   // toward the viewer, screen right, screen up
  }
  const unit = v => { const L = Math.hypot(v[0], v[1], v[2]); return [v[0] / L, v[1] / L, v[2] / L]; };
  const llVec = (lat, lon) => { const la = lat * D2R, lo = lon * D2R; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
  function drawGlobe(g, w, h) {
    const B = globeBasis(), F = B.F, Rt = B.Rt, U = B.U, cx = w / 2, cy = h / 2, Rp = Math.min(w, h) / 2 - 30;
    const N = Math.max(120, Math.min(S.playing || GL.drag ? 300 : 560, Math.round(2 * Rp))), R = N / 2 - 1, off = GL.off;
    if (off.width !== N) { off.width = off.height = N; }
    const og = off.getContext('2d'), im = og.createImageData(N, N), dd = im.data, tex = GL.tex, tw = GL.tw, th = GL.th;
    const su = unit(S.now.sun), eu = unit(S.now.earth);
    for (let py = 0; py < N; py++) {
      const y = (N / 2 - (py + 0.5)) / R;
      for (let px = 0; px < N; px++) {
        const x = (px + 0.5 - N / 2) / R, r2 = x * x + y * y, o = (py * N + px) * 4;
        if (r2 >= 1) { dd[o + 3] = 0; continue; }
        const z = Math.sqrt(1 - r2), p0 = x * Rt[0] + y * U[0] + z * F[0], p1 = x * Rt[1] + y * U[1] + z * F[1], p2 = y * U[2] + z * F[2];
        let t = 150;
        if (tex) {
          const lat = Math.asin(Math.max(-1, Math.min(1, p2))), lon = Math.atan2(p1, p0);
          const tu = Math.min(tw - 1, ((lon / Math.PI + 1) / 2 * tw) | 0), tv = Math.min(th - 1, ((0.5 - lat / Math.PI) * th) | 0);
          t = tex[tv * tw + tu];
        }
        const d = p0 * su[0] + p1 * su[1] + p2 * su[2], k = Math.max(0, Math.min(1, (d + 0.02) / 0.1)), day = k * k * (3 - 2 * k);   // soft day and night line
        const es = Math.max(0, p0 * eu[0] + p1 * eu[1] + p2 * eu[2]) * 0.07;                                                      // faint earthshine on the night side
        const lit = (0.05 + es) * (1 - day) + (0.62 + 0.38 * Math.sqrt(Math.max(0, d))) * day, v = t * lit * (0.82 + 0.18 * z) * 1.25;
        dd[o] = Math.min(255, v); dd[o + 1] = Math.min(255, v * 0.98); dd[o + 2] = Math.min(255, v * (0.94 + 0.5 * es * (1 - day)));
        dd[o + 3] = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * R)) * 255;                                                      // smooth limb
      }
    }
    og.putImageData(im, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(off, cx - Rp, cy - Rp, 2 * Rp, 2 * Rp);
    const proj = v => { const z = v[0] * F[0] + v[1] * F[1] + v[2] * F[2]; return { x: cx + (v[0] * Rt[0] + v[1] * Rt[1]) * Rp, y: cy - (v[0] * U[0] + v[1] * U[1] + v[2] * U[2]) * Rp, z }; };
    // where Earth sits exactly on a level horizon: a great circle 90 degrees from the point under Earth
    const a1 = unit(Math.abs(eu[2]) < 0.9 ? [-eu[1], eu[0], 0] : [0, -eu[2], eu[1]]), a2 = [eu[1] * a1[2] - eu[2] * a1[1], eu[2] * a1[0] - eu[0] * a1[2], eu[0] * a1[1] - eu[1] * a1[0]];
    g.strokeStyle = '#62a0f2'; g.lineWidth = 1.6; g.setLineDash([5, 4]); g.beginPath(); let pen = false;
    for (let b = 0; b <= 360; b += 2) { const cb = Math.cos(b * D2R), sb = Math.sin(b * D2R), q = proj([a1[0] * cb + a2[0] * sb, a1[1] * cb + a2[1] * sb, a1[2] * cb + a2[2] * sb]); if (q.z < 0) { pen = false; continue; } pen ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); pen = true; }
    g.stroke(); g.setLineDash([]);
    // the poles
    g.font = FONTC(12, 500); g.textBaseline = 'middle'; g.textAlign = 'center';
    [['N', [0, 0, 1]], ['S', [0, 0, -1]]].forEach(([t, v]) => { const q = proj(v); if (q.z < 0) return; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(q.x - 4, q.y); g.lineTo(q.x + 4, q.y); g.moveTo(q.x, q.y - 4); g.lineTo(q.x, q.y + 4); g.stroke(); g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.strokeText(t, q.x + 10, q.y - 8); g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillText(t, q.x + 10, q.y - 8); });
    mapGeom = { globe: true, cx, cy, R: Rp, w, h, hits: [] };
    const front = s => proj(llVec(s.lat, s.lon)).z > 0.02;
    mapGeom.hits = markers(g, (la, lo) => { const q = proj(llVec(la, lo)); return [q.x, q.y]; }, front);
    // the Sun and Earth: on the disc where they are overhead, or just off the limb in their direction
    [['sun', su, 'Sun', '#ffd98a'], ['earth', eu, 'Earth', '#b9d6ff']].forEach(([kind, v, name, col]) => {
      const q = proj(v), dx = q.x - cx, dy = q.y - cy, L = Math.hypot(dx, dy), on = q.z > 0 && L < Rp * 0.9;
      const x = on ? q.x : cx + dx / (L || 1) * (Rp + 14), y = on ? q.y : cy + dy / (L || 1) * (Rp + 14);
      glyph(g, x, y, kind);
      const t = on ? name + ' overhead' : 'To ' + (kind === 'sun' ? 'the Sun' : 'Earth'); g.font = FONTC(12, 500); const twd = g.measureText(t).width, lx = Math.max(4, Math.min(w - twd - 4, x - twd / 2)), ly = y > cy ? Math.min(h - 8, y + 20) : Math.max(8, y - 20);
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(t, lx, ly); g.fillStyle = col; g.fillText(t, lx, ly);
    });
    $('mapcap').textContent = 'The whole Moon, lit from the true direction of the Sun, so the edge of the bright side is the real day and night line. Outside the dashed blue line Earth is below a level horizon. Drag to turn the globe; tap anywhere to evaluate that point.';
  }
  function globeUnproject(x, y) {
    const B = globeBasis(), u = (x - mapGeom.cx) / mapGeom.R, v = (mapGeom.cy - y) / mapGeom.R, r2 = u * u + v * v; if (r2 >= 1) return null;
    const z = Math.sqrt(1 - r2), p = [u * B.Rt[0] + v * B.U[0] + z * B.F[0], u * B.Rt[1] + v * B.U[1] + z * B.F[1], v * B.U[2] + z * B.F[2]];
    return { lat: Math.asin(Math.max(-1, Math.min(1, p[2]))) * R2D, lon: Math.atan2(p[1], p[0]) * R2D };
  }
  function drawMap() {
    const cv = $('map'); if (!shown(cv)) return; const polar = S.mapTab === 'pole';
    const cw = cv.clientWidth; cv.style.height = (polar ? cw : Math.round(cw / 2)) + 'px';
    const { g, w, h } = prep(cv); g.fillStyle = '#0a0c11'; g.fillRect(0, 0, w, h);
    $('m-pole').classList.toggle('on', polar); $('m-globe').classList.toggle('on', S.mapTab === 'globe'); $('m-flat').classList.toggle('on', S.mapTab === 'flat'); $('layerseg').hidden = !polar;
    cv.style.cursor = S.mapTab === 'globe' ? 'grab' : 'crosshair'; cv.style.touchAction = S.mapTab === 'globe' ? 'none' : '';
    if (S.mapTab === 'globe') { cv.style.height = cw + 'px'; const p = prep(cv); p.g.fillStyle = '#0a0c11'; p.g.fillRect(0, 0, p.w, p.h); drawGlobe(p.g, p.w, p.h); return; }
    $('l-sun').classList.toggle('on', S.layer === 'sun'); $('l-earth').classList.toggle('on', S.layer === 'earth');
    const ss = Eng.subPoint(S.now.sun), sE = Eng.subPoint(S.now.earth);
    if (polar) {
      const earth = S.layer === 'earth';
      if (earth) castPolar(S.now.earth, true, 0.95, pFrac, pInc); else sunRaster();
      const fr = earth ? pFrac : sunF, inc = earth ? pInc : sunI, dd = img.data;
      for (let i = 0; i < PS * PS; i++) {
        const o = i * 4; if (!pIn[i]) { dd[o + 3] = 0; continue; }
        const hill = pHill[i], base = 16 + 44 * hill; let r, gg, b;
        if (earth) { const f = fr[i], k = 0.4 + 0.6 * hill; r = base * (1 - f) + 60 * k * f; gg = base * (1 - f) + 135 * k * f; b = (base + 8) * (1 - f) + 235 * k * f; }
        else { const f = fr[i] * Math.pow(Math.min(1, inc[i] / 0.1), 0.55), k = 0.62 + 0.38 * hill; r = base * (1 - f) + 255 * k * f; gg = base * (1 - f) + 236 * k * f; b = (base + 8) * (1 - f) + 200 * k * f; }
        dd[o] = r; dd[o + 1] = gg; dd[o + 2] = b; dd[o + 3] = 255;
      }
      offg.putImageData(img, 0, 0);
      const cx = w / 2, cy = h / 2, R = w / 2 - 20;
      g.save(); g.beginPath(); g.arc(cx, cy, R, 0, 7); g.clip(); g.imageSmoothingEnabled = true; g.drawImage(off, cx - R, cy - R, 2 * R, 2 * R); g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1; g.font = FONT(10); g.fillStyle = 'rgba(255,255,255,0.6)'; g.textAlign = 'left'; g.textBaseline = 'middle';
      for (const la of [-88, -86, -84, -82, -80]) { const rr = 2 * RM * Math.tan((90 + la) / 2 * D2R) / RHO * R; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke(); if (la > -88 && la < -80) { g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeText(Math.abs(la) + '°S', cx + 3, cy + rr - 7); g.fillText(Math.abs(la) + '°S', cx + 3, cy + rr - 7); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.16)'; } }
      for (let lo = 0; lo < 360; lo += 45) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + R * Math.sin(lo * D2R), cy - R * Math.cos(lo * D2R)); g.stroke(); }
      g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = FONTC(12, 500);
      [['0° · NEAR SIDE', 0], ['90°E', 90], ['180° · FAR SIDE', 180], ['90°W', 270]].forEach(([t, lo]) => { const rr = R + 10; let x = cx + rr * Math.sin(lo * D2R), y = cy - rr * Math.cos(lo * D2R); if (lo === 90 || lo === 270) { g.save(); g.translate(x, y); g.rotate(lo === 90 ? Math.PI / 2 : -Math.PI / 2); g.fillText(t, 0, 0); g.restore(); } else g.fillText(t, x, y); });
      mapGeom = { polar: true, cx, cy, R, w, h, hits: [] };
      mapGeom.hits = markers(g, (la, lo) => polarXY(la, lo, R, cx, cy), s => s.lat <= CAP);
      glyph(g, cx + (R - 12) * Math.sin(ss.lon * D2R), cy - (R - 12) * Math.cos(ss.lon * D2R), 'sun');
      glyph(g, cx + (R - 12) * Math.sin(sE.lon * D2R), cy - (R - 12) * Math.cos(sE.lon * D2R), 'earth');
      $('mapcap').textContent = (earth ? 'Blue ground has line of sight to Earth right now. ' : 'Bright ground is in sunlight right now; shadows are cast from the LOLA terrain. ') + 'The Sun and Earth symbols on the rim show their directions. Coverage is 80°S to the pole. Tap anywhere to evaluate that point.';
    } else {
      if (texImg && texImg.complete) g.drawImage(texImg, 0, 0, w, h);
      const nw = 240, nh = 120; nightCv = nightCv || document.createElement('canvas'); nightCv.width = nw; nightCv.height = nh; const ng = nightCv.getContext('2d'), ni = ng.createImageData(nw, nh);
      const sv = S.now.sun, L = Math.hypot(sv[0], sv[1], sv[2]), ux = sv[0] / L, uy = sv[1] / L, uz = sv[2] / L;
      for (let y = 0; y < nh; y++) { const la = (90 - (y + 0.5) * 180 / nh) * D2R, cl = Math.cos(la), sl = Math.sin(la); for (let x = 0; x < nw; x++) { const lo = (-180 + (x + 0.5) * 360 / nw) * D2R; const el = Math.asin(ux * cl * Math.cos(lo) + uy * cl * Math.sin(lo) + uz * sl) * R2D; const a = Math.max(0, Math.min(1, (1.5 - el) / 3)); const o = (y * nw + x) * 4; ni.data[o] = 4; ni.data[o + 1] = 6; ni.data[o + 2] = 14; ni.data[o + 3] = a * 200; } }
      ng.putImageData(ni, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(nightCv, 0, 0, w, h);
      const proj = (la, lo) => { const l = ((lo + 180) % 360 + 360) % 360 - 180; return [(l + 180) / 360 * w, (90 - la) / 180 * h]; };
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1; for (let lo = -150; lo < 180; lo += 30) { const x = (lo + 180) / 360 * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } for (let la = -60; la < 90; la += 30) { const y = (90 - la) / 180 * h; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      const circle = (c, col, dash) => { g.strokeStyle = col; g.lineWidth = 1.6; g.setLineDash(dash); g.beginPath(); let px = null; const la0 = c.lat * D2R, lo0 = c.lon * D2R; for (let b = 0; b <= 360; b += 2) { const la = Math.asin(Math.cos(la0) * Math.cos(b * D2R)), lo = lo0 + Math.atan2(Math.sin(b * D2R) * Math.cos(la0), -Math.sin(la0) * Math.sin(la)); const [x, y] = proj(la * R2D, lo * R2D); if (px !== null && Math.abs(x - px) < w / 2) g.lineTo(x, y); else g.moveTo(x, y); px = x; } g.stroke(); g.setLineDash([]); };
      circle(ss, '#f0b03a', []); circle(sE, '#62a0f2', [5, 4]);
      mapGeom = { polar: false, w, h, hits: [] }; mapGeom.hits = markers(g, proj, () => true);
      const a = proj(ss.lat, ss.lon), b = proj(sE.lat, sE.lon); glyph(g, a[0], a[1], 'sun'); glyph(g, b[0], b[1], 'earth');
      $('mapcap').textContent = 'The Sun symbol marks where it is overhead; the amber line is the day and night boundary. The Earth symbol marks where Earth is overhead; outside the dashed blue line Earth is below the horizon. Tap anywhere to evaluate that point.';
    }
  }
  $('map').addEventListener('click', e => {
    if (!mapGeom) return; if (GL.moved) { GL.moved = false; return; } const r = $('map').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 14; mapGeom.hits.forEach(hh => { const d = Math.hypot(hh.x - x, hh.y - y); if (d < bd) { bd = d; best = hh.s; } });
    if (best) { pickSite(best.id, true); return; }
    if (mapGeom.globe) { const q = globeUnproject(x, y); if (q) setCustom(q.lat, q.lon, true); return; }
    if (mapGeom.polar) { const dx = x - mapGeom.cx, dy = mapGeom.cy - y, rr = Math.hypot(dx, dy); if (rr > mapGeom.R) return; const lat = -90 + 2 * Math.atan(rr / mapGeom.R * RHO / (2 * RM)) * R2D; setCustom(lat, Math.atan2(dx, dy) * R2D); }
    else setCustom(90 - y / mapGeom.h * 180, x / mapGeom.w * 360 - 180);
  });

  // ---------- report ----------
  function reportText() {
    const c = S.cfg, m = Ana.siteMask(S.site, S.eye), mv = S.mv, r = computeRescue(), L = [];
    L.push('# Lunar Skyline mission report', '', 'Generated ' + fmtDT(Date.now()) + '.', '');
    L.push('## Scenario', '- Site: ' + S.site.name + ' (' + fmtLat(S.site.lat) + ', ' + fmtLon(S.site.lon) + '), terrain height ' + Math.round(m.h0) + ' m, mast ' + S.eye + ' m', '- Terrain: ' + tierText(m) + ', ' + sg(m.lo, 1) + ' to ' + sg(m.hi, 1), '- Landing: ' + fmtDT(mv.t), '- Surface mission: ' + c.days + ' days', '');
    L.push('## Mission needs', '- Solar array: ' + c.peakW + ' W in full Sun, ' + (c.tracking ? 'sun-tracking' : 'fixed horizontal'), '- Load: ' + c.loadSun + ' W in sunlight, ' + c.loadDark + ' W in darkness', '- Battery: ' + c.capWh + ' Wh, reserve ' + Math.round(c.minSoc * 100) + '%, charge efficiency ' + Math.round(c.chargeEff * 100) + '%',
      '- Direct Earth link: ' + (c.needEarth ? 'required, longest gap ' + c.maxGapH + ' h' : 'not required'), '- Terrain margin: ' + c.margin + '° added to every horizon', '');
    if (c.fault.kind !== 'none' || c.safe) L.push('## Stress test', '- ' + $('mv-fault').textContent, '');
    L.push('## Verdict: ' + STL[mv.st], '- Lowest battery: ' + Math.round(mv.nom.minSoc * 100) + '% on mission day ' + (mv.nom.kMin / 24).toFixed(1) + ' (' + Math.round(mv.rob.minSoc * 100) + '% with the terrain margin)', '- Battery needed to ride out the longest shortfall: ' + fmtWh(mv.nom.battNeedWh),
      '- Time in sunlight: ' + mv.nom.litPct.toFixed(0) + '%, longest dark stretch ' + fmtH(mv.nom.maxDarkH), '- Earth line of sight: ' + mv.nom.linkPct.toFixed(0) + '% of the mission, longest gap ' + fmtH(mv.nom.maxGapH));
    if (mv.nom.fails.length) L.push('- Fails because ' + mv.nom.fails.join('; ')); else if (mv.rob.fails.length) L.push('- With the terrain margin: ' + mv.rob.fails.join('; '));
    L.push('');
    if (LAB.F) { const b = LAB.F.best; L.push('## Design lab', b ? '- Lightest array and battery that pass with the terrain margin: ' + fmtW(b.peakW) + ' + ' + fmtCap(b.capWh) + ', about ' + fmtKg(b.mass) + ' at ' + LAB.wkg + ' W/kg and ' + LAB.whkg + ' Wh/kg (screening figure)' : '- No array and battery pass at this landing time', '- Your design: ' + fmtW(c.peakW) + ' + ' + fmtCap(c.capWh) + ', about ' + fmtKg(labMass(c.peakW, c.capWh)), '- Blackout rule: ride out ' + c.autonomyH + ' h at the darkness load from the lowest charge', ''); }
    const k = S.risk;
    if (k && k.key === riskKey()) {
      L.push('## Landing risk (Monte Carlo)', '- Chance of success: ' + Math.round(k.p * 100) + '% (95% interval ' + Math.round(k.lo * 100) + ' to ' + Math.round(k.hi * 100) + '%, reflecting the number of simulated missions only), from ' + k.total.toLocaleString('en-US') + ' simulated missions, seed ' + S.sig.seed,
        '- Spreads (3 sigma): touchdown within ' + S.acc + ' m, landing time within ' + S.tjit + ' h; 1 sigma: terrain ' + S.sig.terrain + '°, array output ' + S.sig.power + '%, loads ' + S.sig.load + '%, battery ' + S.sig.cap + '%' + (S.sig.corr ? ', loads and battery linked' : '') + '; steepest safe slope ' + S.sig.slope + '°',
        '- Failure causes: ' + Ana.CAUSES.map((nm, j) => nm.toLowerCase() + ' ' + Math.round(k.causes[j] * 100) + '%').slice(0, 5).join(', '),
        '- If one thing were known exactly: ' + k.drivers.map(d => d[0].toLowerCase() + ' ' + Math.round(d[1] * 100) + '%').join(', '),
        k.best.clear ? '- Best aim point nearby (checked on separate draws): ' + Math.round(k.best.p * 100) + '% at ' + fmtLat(k.best.lat) + ' ' + fmtLon(k.best.lon) + ' (' + fmtDist(k.best.dist) + ' away)' : '- No better aim point found within ' + fmtDist(1.5 * k.Rkm), '');
    }
    if (r) {
      L.push('## Mission Rescue', 'Plan: ' + S.plan.site.name + ', landing ' + fmtDT(S.plan.t) + ' (' + STN[r.base.state].toLowerCase() + '). After a ' + S.slip + '-day slip at the same site: ' + STN[r.slipped.state].toLowerCase() + (r.slipped.state === 0 ? ', ' + r.slipped.nom.fails[0] : '') + '.', '',
        '| # | Site | Land on (UTC) | Extra wait | Verdict | Lowest battery | Longest link gap | Terrain |', '|---|---|---|---|---|---|---|---|');
      r.alts.slice(0, 8).forEach((a, k) => L.push('| ' + (k + 1) + ' | ' + short(a.site) + ' | ' + (a.state ? fmtDT(tab.t0 + a.i * HOUR).replace(' UTC', '') : 'none') + ' | ' + (a.state ? '+' + ((a.i - r.iS) / 24).toFixed(2) + ' d' : 'n/a') + ' | ' + STN[a.state] + ' | ' + Math.round(a.v.nom.minSoc * 100) + '% | ' + fmtH(a.v.nom.maxGapH) + ' | ' + a.tier + ' |'));
      L.push('');
    }
    L.push('## Method and limits', '- Sun and Earth positions: Astronomy Engine with the IAU lunar rotation model; largest difference from JPL DE421/SPICE 0.004° over 3,166 epochs at six sites.',
      '- Terrain: NASA LOLA south-pole model LDEM_80S_80MPP_ADJ (80 m for listed sites, 400 m for other points south of 80°S); coarse LOLA grid elsewhere.',
      '- Power is geometric: array output in full Sun times the visible fraction of the solar disc, scaled for Sun distance. Thermal effects, dust and pointing limits are not modelled.',
      '- Earth contact is line of sight to Earth\'s centre. Antenna pointing, link margin and ground-station scheduling are not modelled.', '- Hourly sampling; rise and set times refined to seconds.');
    return L.join('\n');
  }

  // ---------- state changes ----------
  function syncInputs() {
    const d = new Date(S.t); $('when').value = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
    $('lat').value = (+S.site.lat.toFixed(4)); $('lon').value = (+S.site.lon.toFixed(4));
    document.querySelectorAll('[data-span]').forEach(b => b.classList.toggle('on', +b.dataset.span === S.span));
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
    document.querySelectorAll('[data-v]').forEach(s => { s.hidden = s.dataset.v !== S.view; });
  }
  function setTime(t, jump) {
    S.t = t;
    if (jump || t < S.anchor || t > S.anchor + S.span * DAY) S.anchor = floorDay(t);
    if (jump) S.calAnchor = S.anchor;
    syncInputs(); render();
  }
  function fillSelects() {
    const groups = {}; SITES.forEach(s => (groups[s.g] = groups[s.g] || []).push(s));
    const opt = s => '<option value="' + s.id + '">' + s.name + '</option>';
    let h = Object.keys(groups).map(k => '<optgroup label="' + k + '">' + groups[k].map(opt).join('') + '</optgroup>').join('');
    if (S.custom) h += '<optgroup label="Custom"><option value="custom">' + S.custom.name + '</option></optgroup>';
    $('site').innerHTML = h; $('site').value = S.site.id;
    const inCmp = rows().map(s => s.id);
    $('addcmp').innerHTML = '<option value="">Choose…</option>' + Object.keys(groups).map(k => '<optgroup label="' + k + '">' + groups[k].filter(s => !inCmp.includes(s.id)).map(opt).join('') + '</optgroup>').join('');
  }
  function pickSite(id, keepMap) {
    S.site = byId(id) || SITES[0]; Terrain.setFocus(S.site.lat, S.site.lon); VW.az = null;
    if (!keepMap) { S.mapTab = S.site.lat <= CAP ? 'pole' : 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon; }
    fillSelects(); syncInputs(); render();
  }
  function setCustom(lat, lon, keepMap) {
    lat = Math.max(-90, Math.min(90, lat)); lon = ((lon + 180) % 360 + 360) % 360 - 180;
    S.custom = { id: 'custom', g: 'Custom', name: 'Custom ' + fmtLat(lat) + ' ' + fmtLon(lon), lat, lon, note: 'Custom coordinates.' };
    pickSite('custom', keepMap);
  }
  // ---------- shareable link: the whole scenario in the address ----------
  const hashView = () => location.hash.slice(1).split('?')[0];
  const MKEYS = [['m-days', c => c.days], ['m-peak', c => c.peakW], ['m-lsun', c => c.loadSun], ['m-ldark', c => c.loadDark], ['m-cap', c => c.capWh], ['m-res', c => Math.round(c.minSoc * 100)], ['m-gap', c => c.maxGapH], ['m-margin', c => c.margin], ['m-auto', c => c.autonomyH]];
  function shareLink() {
    const c = S.cfg, q = new URLSearchParams();
    if (S.site.id === 'custom') { q.set('lat', S.site.lat.toFixed(4)); q.set('lon', S.site.lon.toFixed(4)); } else q.set('site', S.site.id);
    q.set('t', new Date(S.t).toISOString().slice(0, 16)); q.set('mast', S.eye); if (S.cmp.length) q.set('cmp', S.cmp.join('_'));
    q.set('m', MKEYS.map(k => k[1](c)).join('_')); q.set('f', (c.tracking ? 1 : 0) + '_' + (c.needEarth ? 1 : 0)); if (c.fault.kind !== 'none' || c.safe) q.set('x', c.fault.kind + '_' + c.fault.day + '_' + (c.safe ? 1 : 0));
    return location.href.split('#')[0] + '#' + S.view + '?' + q.toString();
  }
  // Reads a scenario from the address. Returns true when one was applied. Every value goes through the same limits as the form.
  function applyLink() {
    const h = location.hash.slice(1), k = h.indexOf('?'); if (k < 0) return false;
    let q; try { q = new URLSearchParams(h.slice(k + 1)); } catch (_) { return false; }
    const v = hashView(); if (VIEWS.includes(v)) S.view = v;
    const m = (q.get('m') || '').split('_'); if (m.length === MKEYS.length && m.every(x => isFinite(parseFloat(x)))) MKEYS.forEach((kk, i) => { $(kk[0]).value = m[i]; });
    const f = (q.get('f') || '').split('_'); if (f.length === 2) { $('m-array').value = f[0] === '0' ? 'flat' : 'track'; $('m-dte').checked = f[1] !== '0'; }
    const x = (q.get('x') || 'none_3_0').split('_'), kinds = ['none', 'array', 'load', 'battery', 'antenna'];   // the stress test; a link without one clears it
    $('m-fault').value = kinds.includes(x[0]) ? x[0] : 'none'; $('m-fday').value = isFinite(parseFloat(x[1])) ? x[1] : 3; $('m-safe').checked = x[2] === '1';
    readCfg();
    const eye = parseFloat(q.get('mast')); if (isFinite(eye)) { S.eye = Math.max(0, Math.min(2000, eye)); $('eye').value = S.eye; serCache.clear(); rescueKey = ''; }
    if (q.has('cmp')) S.cmp = q.get('cmp').split('_').filter(id => SITES.some(s => s.id === id)).slice(0, 4);
    const la = parseFloat(q.get('lat')), lo = parseFloat(q.get('lon')), sid = q.get('site');
    if (isFinite(la) && isFinite(lo)) { const lat = Math.max(-90, Math.min(90, la)), lon = ((lo + 180) % 360 + 360) % 360 - 180; S.custom = { id: 'custom', g: 'Custom', name: 'Custom ' + fmtLat(lat) + ' ' + fmtLon(lon), lat, lon, note: 'Custom coordinates.' }; S.site = S.custom; }
    else if (sid && SITES.some(s => s.id === sid)) S.site = byId(sid);
    Terrain.setFocus(S.site.lat, S.site.lon); VW.az = null; S.mapTab = S.site.lat <= CAP ? 'pole' : 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon;
    const t = Date.parse((q.get('t') || '') + ':00Z'); if (isFinite(t) && t > Date.UTC(1950, 0, 1) && t < Date.UTC(2150, 0, 1)) { S.t = t; S.anchor = floorDay(t); S.calAnchor = S.anchor; }
    S.plan = { site: S.site, t: floorHour(S.t) };
    return true;
  }
  function setView(v) { S.view = VIEWS.includes(v) ? v : 'plan'; syncInputs(); render(); try { if (hashView() !== S.view || location.hash.includes('?')) history.replaceState(null, '', '#' + S.view); } catch (_) {} }
  function readCfg() {
    const num = (id, lo, hi, def) => { const v = parseFloat($(id).value); const r = isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; $(id).value = r; return r; };
    const c = S.cfg; c.days = Math.round(num('m-days', 1, 60, 10)); c.peakW = num('m-peak', 0, 1e5, 400); c.tracking = $('m-array').value === 'track'; c.loadSun = num('m-lsun', 0, 1e5, 180); c.loadDark = num('m-ldark', 0, 1e5, 60);
    c.capWh = num('m-cap', 1, 1e6, 2000); c.minSoc = num('m-res', 0, 90, 20) / 100; c.needEarth = $('m-dte').checked; c.maxGapH = num('m-gap', 0, 2000, 12); c.margin = num('m-margin', 0, 3, 0.3);
    c.autonomyH = num('m-auto', 0, 72, 6);
    c.fault = { kind: $('m-fault').value, day: num('m-fday', 0, 60, 3) }; c.safe = $('m-safe').checked; $('m-fday').disabled = c.fault.kind === 'none';
    $('m-gap').disabled = !c.needEarth; render();
  }

  let raf = 0, ready = false;
  function render() {
    if (!ready) return;
    ensureTab();
    S.now = Eng.bodyFixed(S.t); S.cur = Ana.stateFrom(S.site, S.eye, S.now.sun, S.now.earth);
    drawSiteInfo(); drawMission();
    if (S.view === 'plan') { drawLab(); drawRescue(); drawRisk(); scheduleRisk(); }
    else if (S.view === 'explore') { S.ev = { sun: nextEvent(S.site, 'sunClr'), earth: nextEvent(S.site, 'earthClr') }; drawSurface(); drawStatus(); drawSky(); drawTimeline(); drawMap(); }
    else if (S.view === 'learn') drawLearn();
    else { drawCmpSky(); drawCompare(); drawCalendar(); }
  }
  function renderSoon() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  // ---------- events ----------
  $('site').addEventListener('change', e => pickSite(e.target.value));
  $('usecoord').addEventListener('click', () => { const la = parseFloat($('lat').value), lo = parseFloat($('lon').value); if (isFinite(la) && isFinite(lo)) setCustom(la, lo); });
  $('eye').addEventListener('change', e => { const v = parseFloat(e.target.value); S.eye = isFinite(v) ? Math.max(0, Math.min(2000, v)) : 2; e.target.value = S.eye; serCache.clear(); rescueKey = ''; render(); });
  $('when').addEventListener('change', e => { const t = Date.parse(e.target.value + ':00Z'); if (isFinite(t)) setTime(t, true); });
  $('bnow').addEventListener('click', () => setTime(Math.round(Date.now() / 60000) * 60000, true));
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => setTime(S.t + (+b.dataset.step) * HOUR, false)));
  document.querySelectorAll('[data-span]').forEach(b => b.addEventListener('click', () => { S.span = +b.dataset.span; if (S.t > S.anchor + S.span * DAY) S.anchor = floorDay(S.t); syncInputs(); render(); }));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  window.addEventListener('hashchange', () => { if (location.hash.includes('?') && applyLink()) { fillSelects(); syncInputs(); render(); return; } const v = hashView(); if (v && v !== S.view) setView(v); });
  ['m-days', 'm-peak', 'm-array', 'm-lsun', 'm-ldark', 'm-cap', 'm-res', 'm-dte', 'm-gap', 'm-margin', 'm-auto', 'm-fault', 'm-fday', 'm-safe'].forEach(id => $(id).addEventListener('change', readCfg));
  $('s-sun').addEventListener('click', () => { VW.az = S.cur.sunAz; drawSurface(); });
  $('s-earth').addEventListener('click', () => { VW.az = S.cur.earthAz; drawSurface(); });
  $('s-zoom').addEventListener('click', () => { VW.fov = VW.fov === 90 ? 45 : VW.fov === 45 ? 20 : 90; drawSurface(); });
  (() => { const cv = $('surf'); let px = null, az0 = 0, pend = 0;
    cv.addEventListener('pointerdown', e => { px = e.clientX; az0 = VW.az; VW.drag = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener('pointermove', e => { if (px === null || VW.az === null) return; VW.az = az0 - (e.clientX - px) / cv.clientWidth * VW.fov; if (!pend) pend = requestAnimationFrame(() => { pend = 0; drawSurface(); }); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { if (px !== null) { px = null; VW.drag = false; drawSurface(); } })); })();
  ['d-wkg', 'd-whkg'].forEach(id => $(id).addEventListener('change', () => { const v = parseFloat($('d-wkg').value), u = parseFloat($('d-whkg').value); LAB.wkg = isFinite(v) ? Math.max(5, Math.min(500, v)) : 80; LAB.whkg = isFinite(u) ? Math.max(20, Math.min(500, u)) : 160; $('d-wkg').value = LAB.wkg; $('d-whkg').value = LAB.whkg; drawLab(); }));
  $('d-hard').addEventListener('click', () => setHardware(100, 500));
  $('d-apply').addEventListener('click', () => { const b = LAB.F && LAB.F.best; if (b) setHardware(b.peakW, b.capWh); });
  $('dfront').addEventListener('click', e => { const q = LAB.geo; if (!q) return; const r = $('dfront').getBoundingClientRect(), fx = (e.clientX - r.left - q.L) / q.pw, fy = 1 - (e.clientY - r.top - q.T) / q.ph; if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return; setHardware(Math.round(Math.exp(q.y0 + fy * (q.y1 - q.y0)) / 5) * 5, Math.round(Math.exp(q.x0 + fx * (q.x1 - q.x0)) / 10) * 10); });
  $('datlas').addEventListener('click', e => { const q = LAB.ageo, A = LAB.atlas; if (!q || !A) return; const r = $('datlas').getBoundingClientRect(), j = Math.max(0, Math.min(q.NA - 1, Math.floor((e.clientX - r.left - q.L) / q.pw * q.NA))); setTime(tab.t0 + (A.a0 + j * 12) * HOUR, false); });
  $('d-tbl').addEventListener('click', e => { const b = e.target.closest('[data-ai]'), A = LAB.atlas; if (!b || !A) return; const j = +b.dataset.ai, t = tab.t0 + (A.a0 + j * 12) * HOUR, p = A.pk[j], c = A.cp[j]; S.t = t; if (t < S.anchor || t > S.anchor + S.span * DAY) S.anchor = floorDay(t); syncInputs(); setHardware(p, c); });
  $('k-acc').addEventListener('change', e => { const v = parseFloat(e.target.value); S.acc = isFinite(v) ? Math.max(200, Math.min(5000, v)) : 1000; e.target.value = S.acc; drawRisk(); scheduleRisk(); });
  $('k-time').addEventListener('change', e => { const v = parseFloat(e.target.value); S.tjit = isFinite(v) ? Math.max(0, Math.min(72, v)) : 6; e.target.value = S.tjit; drawRisk(); scheduleRisk(); });
  const sigIn = () => { const num = (id, lo, hi, def) => { const v = parseFloat($(id).value), r = isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; $(id).value = r; return r; };
    S.sig = { power: num('k-sp', 0, 50, 5), load: num('k-sl', 0, 50, 5), cap: num('k-sb', 0, 50, 3), terrain: num('k-st', 0, 2, 0.15), slope: num('k-slope', 1, 45, 12), corr: $('k-corr').checked, seed: Math.round(num('k-seed', 1, 2e9, 20261114)) }; drawRisk(); scheduleRisk(); };
  ['k-sp', 'k-sl', 'k-sb', 'k-st', 'k-slope', 'k-corr', 'k-seed'].forEach(id => $(id).addEventListener('change', sigIn));
  $('k-new').addEventListener('click', () => { $('k-seed').value = 1 + Math.floor(Math.random() * 1.9e9); sigIn(); });
  $('k-go').addEventListener('click', () => { const r = S.risk; if (r && r.key === riskKey()) setCustom(r.best.lat, r.best.lon); });
  $('risk').addEventListener('click', e => { const r = S.risk; if (!r || r.key !== riskKey()) return; const b = $('risk').getBoundingClientRect(), ix = Math.max(0, Math.min(r.n - 1, Math.floor((e.clientX - b.left) / b.width * r.n))), iy = Math.max(0, Math.min(r.n - 1, Math.floor((e.clientY - b.top) / b.width * r.n))); setCustom(r.lat[iy * r.n + ix], r.lon[iy * r.n + ix]); });
  $('r-slip').addEventListener('input', e => { S.slip = +e.target.value; drawRescue(); });
  $('r-flex').addEventListener('change', e => { const v = parseFloat(e.target.value); S.flex = isFinite(v) ? Math.max(0, Math.min(60, Math.round(v))) : 10; e.target.value = S.flex; drawRescue(); });
  $('r-scope').addEventListener('change', e => { S.scope = e.target.value; drawRescue(); });
  $('r-set').addEventListener('click', () => { S.plan = { site: S.site, t: floorHour(S.t) }; drawRescue(); });
  $('r-tbl').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (!b) return; S.site = byId(b.dataset.open) || S.site; Terrain.setFocus(S.site.lat, S.site.lon); VW.az = null; S.mapTab = S.site.lat <= CAP ? 'pole' : 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon; S.t = +b.dataset.t; if (S.t < S.anchor || S.t > S.anchor + S.span * DAY) S.anchor = floorDay(S.t); fillSelects(); syncInputs(); render(); document.querySelector('[aria-label="Mission verdict"]').scrollIntoView({ block: 'nearest' }); });
  let last = 0, lastDraw = 0;
  function tick(ts) {
    if (!S.playing) return; const dt = Math.min(200, ts - (last || ts)); last = ts; S.t += dt * 86400;
    if (ts - lastDraw > 70) { lastDraw = ts; setTime(S.t, false); }
    requestAnimationFrame(tick);
  }
  $('play').addEventListener('click', () => { S.playing = !S.playing; $('play').textContent = S.playing ? 'Pause' : 'Play'; last = 0; if (S.playing) requestAnimationFrame(tick); else setTime(Math.round(S.t / 60000) * 60000, false); });
  const scrubTo = t => { S.t = Math.round(t / 60000) * 60000; syncInputs(); renderSoon(); };
  scrub($('tl'), TLP.l, TLP.r, scrubTo); scrub($('cmp'), 8, 8, scrubTo);
  const calDay = e => { const r = $('cal').getBoundingClientRect(); return Math.max(0, Math.min(365, Math.floor((e.clientX - r.left - CALP.l) / (r.width - CALP.l - CALP.r) * 366))); };
  $('cal').addEventListener('pointermove', e => { calHover = calDay(e); drawCalendar(); });
  $('cal').addEventListener('pointerleave', () => { calHover = null; drawCalendar(); });
  $('cal').addEventListener('click', e => { const d = calDay(e); calHover = null; S.t = S.calAnchor + d * DAY; S.anchor = floorDay(S.t); syncInputs(); render(); });
  $('chips').addEventListener('click', e => { const id = e.target.dataset && e.target.dataset.rm; if (id) { S.cmp = S.cmp.filter(x => x !== id); fillSelects(); render(); } });
  $('addcmp').addEventListener('change', e => { const id = e.target.value; if (id && !S.cmp.includes(id)) { S.cmp.push(id); if (S.cmp.length > 4) S.cmp.shift(); } fillSelects(); render(); });
  $('m-pole').addEventListener('click', () => { S.mapTab = 'pole'; drawMap(); }); $('m-globe').addEventListener('click', () => { S.mapTab = 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon; drawMap(); }); $('m-flat').addEventListener('click', () => { S.mapTab = 'flat'; drawMap(); });
  (() => { const cv = $('map'); let p0 = null, pend = 0;       // drag to turn the globe
    cv.addEventListener('pointerdown', e => { if (S.mapTab !== 'globe') return; p0 = { x: e.clientX, y: e.clientY, lat: GL.lat, lon: GL.lon }; GL.moved = false; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener('pointermove', e => { if (!p0 || !mapGeom || !mapGeom.globe) return; const dx = e.clientX - p0.x, dy = e.clientY - p0.y; if (!GL.moved && Math.hypot(dx, dy) < 5) return; GL.moved = true; GL.drag = true;
      GL.lon = p0.lon - dx / mapGeom.R * R2D; GL.lat = Math.max(-90, Math.min(90, p0.lat + dy / mapGeom.R * R2D)); if (!pend) pend = requestAnimationFrame(() => { pend = 0; drawMap(); }); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { if (!p0) return; p0 = null; if (GL.drag) { GL.drag = false; drawMap(); } })); })();
  $('l-sun').addEventListener('click', () => { S.layer = 'sun'; drawMap(); }); $('l-earth').addEventListener('click', () => { S.layer = 'earth'; drawMap(); });
  function copy(text, msgEl, okMsg) {
    const done = ok => { $(msgEl).textContent = ok ? okMsg : 'The browser blocked the copy. Open the page in its own tab and try again.'; };
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch (_) { done(false); }
  }
  function csvText() {
    const se = ser(S.site), a0 = idx(S.anchor), nW = S.span * 24, L = ['time_utc,sun_elevation_deg,sun_azimuth_deg,sun_above_terrain_deg,sun_disc_fraction,earth_elevation_deg,earth_azimuth_deg,earth_above_terrain_deg'];
    for (let i = a0; i <= a0 + nW && i < tab.n; i++) L.push([new Date(tab.t0 + i * HOUR).toISOString().slice(0, 16) + 'Z', se.sunEl[i].toFixed(3), se.sunAz[i].toFixed(2), se.sunClr[i].toFixed(3), se.sunFrac[i].toFixed(3), se.earthEl[i].toFixed(3), se.earthAz[i].toFixed(2), se.earthClr[i].toFixed(3)].join(','));
    return L;
  }
  function download(name, text, type) {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileStem = () => 'lunar-skyline-' + (S.site.id === 'custom' ? 'custom' : S.site.id) + '-' + new Date(S.t).toISOString().slice(0, 10);
  $('csv').addEventListener('click', () => { const L = csvText(); copy(L.join('\n'), 'csvmsg', 'Copied ' + (L.length - 1) + ' rows for ' + S.site.name + '.'); });
  $('csvdl').addEventListener('click', () => { const L = csvText(); download(fileStem() + '.csv', L.join('\n') + '\n', 'text/csv'); $('csvmsg').textContent = 'Saved ' + (L.length - 1) + ' rows for ' + S.site.name + '.'; });
  $('reportdl').addEventListener('click', () => { download(fileStem() + '-report.md', reportText() + '\n', 'text/markdown'); $('reportmsg').textContent = 'Report saved as a Markdown file.'; });
  $('l-play').addEventListener('click', () => $('play').click());
  $('l-stand').addEventListener('click', () => { pickSite('shack'); setView('explore'); window.scrollTo(0, 0); });
  $('l-compare').addEventListener('click', () => { if (!S.cmp.includes('a11')) { S.cmp.push('a11'); if (S.cmp.length > 4) S.cmp.shift(); } pickSite('shack'); setView('compare'); window.scrollTo(0, 0); });
  $('share').addEventListener('click', () => copy(shareLink(), 'sharemsg', 'Link copied. It reopens this site, time, mission, stress test and comparison.'));
  $('report').addEventListener('click', () => copy(reportText(), 'reportmsg', 'Report copied as Markdown text.'));
  // ---------- guided tour ----------
  const TOUR = [
    { v: 'explore', sel: '[aria-label="Surface view"]', t: 'You are standing on the rim of Shackleton crater, near the Moon\'s south pole. The Sun and the Earth both sit just above the hills. Drag the picture to look around.', go: () => pickSite('shack') },
    { v: 'explore', sel: '[aria-label="Surface view"]', t: 'Days pass in seconds. The Sun slides sideways along the horizon instead of climbing overhead, and the Earth barely moves. That is why one ridge can decide a mission here.', go: () => { tourKeep.t = S.t; if (!S.playing) $('play').click(); }, leave: () => { if (S.playing) $('play').click(); setTime(tourKeep.t, true); } },
    { v: 'explore', sel: '[aria-label="Status now"]', t: 'The same sky as numbers: how far the Sun and the Earth sit above the terrain, and how long until each one sets.' },
    { v: 'plan', sel: '[aria-label="Mission needs"]', t: 'Describe a lander: its solar array, its battery, how long it can go without radio contact. The tool simulates the battery hour by hour and says whether the mission survives.' },
    { v: 'plan', sel: '[aria-label="Design lab"]', t: 'Now work backwards. This lander is too small: a 100 W array and a 500 Wh battery. The green region shows every array and battery pair that survives, the diamond is the lightest, and the atlas below shows which landing dates need the least hardware.',
      go: () => { tourKeep.hw = [S.cfg.peakW, S.cfg.capWh]; setHardware(100, 500); }, leave: () => setHardware(tourKeep.hw[0], tourKeep.hw[1]) },
    { v: 'plan', sel: '[aria-label="Mission verdict"]', t: 'Now break something. At Malapert Massif an unexpected 100 W load appears on mission day 3. Without safe mode the battery runs flat. With it, the lander survives.',
      go: () => { tourKeep.site = S.site.id; tourKeep.t2 = S.t; $('m-fault').value = 'load'; $('m-fday').value = 3; $('m-safe').checked = true; readCfg(); pickSite('mala'); setTime(Date.UTC(2026, 11, 23), true); },
      leave: () => { $('m-fault').value = 'none'; $('m-safe').checked = false; readCfg(); pickSite(tourKeep.site); setTime(tourKeep.t2, true); } },
    { v: 'plan', sel: '[aria-label="Landing risk"]', t: 'No lander touches down exactly on target. Thousands of simulated landings give the real chance of success, show why missions fail, and check whether a nearby aim point is safer.' },
    { v: 'plan', sel: '[aria-label="Mission Rescue"]', t: 'The launch slips by 14 days. The plan may no longer work, so the table ranks the sites and landing times that still do. Move the slider to try other delays.' },
    { v: 'compare', sel: '[aria-label="Landing-date calendar"]', t: 'Last, compare sites over a whole year. Green columns are landing days that meet the mission\'s needs. Tap any day to go there.' },
  ];
  const tourKeep = {}; let tourI = -1;
  function tourShow(i) {
    if (tourI >= 0 && TOUR[tourI].leave) TOUR[tourI].leave();
    tourI = i; if (i < 0 || i >= TOUR.length) { tourI = -1; $('tour').hidden = true; return; }
    const st = TOUR[i]; if (st.go) st.go(); setView(st.v);
    $('tour').hidden = false; $('tour-n').textContent = 'Step ' + (i + 1) + ' of ' + TOUR.length; $('tour-t').textContent = st.t; $('tour-b').disabled = i === 0; $('tour-x').textContent = i === TOUR.length - 1 ? 'Finish' : 'Next';
    const el = document.querySelector(st.sel); if (el) { try { el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } catch (_) { el.scrollIntoView(); } el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  }
  $('tour-go').addEventListener('click', () => tourShow(0));
  $('tour-x').addEventListener('click', () => tourShow(tourI + 1));
  $('tour-b').addEventListener('click', () => tourShow(tourI - 1));
  $('tour-c').addEventListener('click', () => tourShow(-1));
  const reTheme = () => { readTheme(); if (S.now) render(); };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reTheme); } catch (_) {}
  new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let rw = 0; new ResizeObserver(() => { const w = document.body.clientWidth; if (w !== rw && S.now) { rw = w; renderSoon(); } }).observe(document.body);

  // ---------- boot ----------
  try {
    readTheme();
    await Terrain.load(LUNAR_DATA);
    for (const id in Terrain.profiles.sites) { const q = Terrain.profiles.sites[id], s = SITES.find(x => x.id === id); if (s && id !== 'pole') { if (Math.abs(s.lat - q.lat) > 1e-4 || Math.abs(s.lon - q.lon) > 1e-4) s.note += ' Placed on the highest ground within 600 m.'; s.lat = q.lat; s.lon = q.lon; } }
    Terrain.setFocus(-70, 0); buildPolar(); Terrain.setFocus(S.site.lat, S.site.lon);
    texImg = new Image(); texImg.onload = () => { try { const c = document.createElement('canvas'); c.width = texImg.naturalWidth; c.height = texImg.naturalHeight; const cg = c.getContext('2d'); cg.drawImage(texImg, 0, 0); const d = cg.getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height); for (let i = 0; i < a.length; i++) a[i] = d[i * 4]; GL.tex = a; GL.tw = c.width; GL.th = c.height; } catch (_) {} if (S.mapTab !== 'pole') drawMap(); }; texImg.src = 'data:image/jpeg;base64,' + LUNAR_DATA.tex;
    const hv = hashView(); if (VIEWS.includes(hv)) S.view = hv;
    ensureTab();
    // default plan: the middle of the first run of landing days at the default site that meet the needs
    const st = calStates(S.site); let d0 = 0; for (let d = 0; d < 120; d++) if (st[d] === 2) { let e = d; while (e + 1 < 366 && st[e + 1] === 2) e++; d0 = Math.floor((d + e) / 2); break; }
    S.plan = { site: S.site, t: S.calAnchor + d0 * DAY }; S.t = S.plan.t; S.anchor = S.calAnchor;
    applyLink();
    $('boot').remove(); $('app').hidden = false; ready = true;
    fillSelects(); syncInputs();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderSoon());
    render();
    window.__ready = true;
  } catch (err) {
    $('boot').textContent = 'The page could not start: ' + (err && err.message ? err.message : err) + '. Reload to try again.';
    throw err;
  }
})();
