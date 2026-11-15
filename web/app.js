/* Mons Carlo web page. Every number comes from the Mons Carlo server (backend/, FastAPI): positions, horizons,
   series, verdicts, mission design, rescue, calendar, landing risk. This file only fetches, interpolates between hourly
   values for smooth playback, and draws. The server's API is documented at /docs. */
import { DAY, HOUR, D2R, R2D, RM, SYNODIC, discFrac, subPoint, maskAt, lerpAz, wrap180 } from './js/geo.js';
import { MON, p2, fmtDate, fmtDM, fmtDT, fmtDur, fmtH, fmtWh, sg, fmtLat, fmtLon, compass, STN, STL, cap1 } from './js/format.js';
import { createServer } from './js/api.js';
import { createTerrain } from './js/terrain.js';

(async function () {
  const $ = id => document.getElementById(id);
  const VIEWS = ['plan', 'explore', 'compare', 'learn', 'method', 'about'];
  // Where the Mons Carlo API runs: ?api=... in the address wins, then web/config.js, then the page's own server.
  const DEBUG = new URLSearchParams(location.search).has('debug');
  if (DEBUG) { window.__dbg = []; const cl = console.log.bind(console); console.log = (...a) => { window.__dbg.push(a.join(' ')); cl(...a); }; }
  const API = (new URLSearchParams(location.search).get('api') || window.MONS_CARLO_API || '').replace(/\/$/, '');
  const srv = createServer({ base: API, onData: () => renderSoon(), isBusy: () => S.playing || S.scrubbing });
  const { api, getJSON, qs, iso, cache, need, failed, latest } = srv;

  // ---------- sites (from the server) ----------
  let SITES = [];
  const byId = id => id === 'custom' ? S.custom : SITES.find(s => s.id === id);
  // Short site name for labels. Two listed sites can share one ("Mons Mouton" is both the VIPER target and the IM-2
  // landing), so those keep the start of their bracket: "Mons Mouton (VIPER)", "Mons Mouton (IM-2)".
  const baseName = s => s.name.split(/,| \(/)[0];
  const short = s => {
    const b = baseName(s); if (!SITES.some(o => o.id !== s.id && baseName(o) === b)) return b;
    const m = /\(([^,)]*)/.exec(s.name); return m ? b + ' (' + m[1].replace(/ (target|landing|candidate)$/, '') + ')' : b;
  };
  // A 95% interval in whole percent, or to one decimal when both ends round to the same number.
  const ciTxt = (lo, hi) => { const a = Math.round(lo * 100), b = Math.round(hi * 100); return a !== b ? a + ' to ' + b + '%' : (lo * 100).toFixed(1) + ' to ' + (hi * 100).toFixed(1) + '%'; };
  const loc = s => s.id === 'custom' || !s.id ? { lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5) } : { site: s.id };
  const siteKey = s => s.id === 'custom' ? 'c' + s.lat.toFixed(5) + ',' + s.lon.toFixed(5) : s.id;

  const floorDay = t => Math.floor(t / DAY) * DAY, floorHour = t => Math.floor(t / HOUR) * HOUR;
  const t0 = Math.round(Date.now() / 60000) * 60000;
  const S = { site: null, custom: null, t: t0, eye: 2, span: 7, landerId: 'reference', landerEdited: false, anchor: floorDay(t0), calAnchor: floorDay(t0), view: 'explore',
              cmp: ['shack', 'mala'], mapTab: 'pole', layer: 'sun', playing: false, plan: null, slip: 14, flex: 21, scope: 'pole', acc: 500, tjit: 6, sig: { power: 5, load: 5, cap: 3, terrain: 0.15, slope: 12, corr: false, seed: 20261114 },
              cfg: { days: 10, peakW: 400, loadSun: 180, loadDark: 60, capWh: 2000, minSoc: 0.2, arrayType: 'track', needEarth: true, useDsn: true, maxGapH: 12, margin: 0.3, chargeEff: 0.9, fault: { kind: 'none', day: 3 }, safe: false, autonomyH: 6, strict: false, heat: false } };

  // ---------- theme and canvas ----------
  let C = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    C = { ink: v('--ink'), muted: v('--muted'), line: v('--line'), line2: v('--line-2'), sun: v('--sun'), earth: v('--earth'), go: v('--go'), warn: v('--warn'), bad: v('--bad'), cell: v('--cell'), panel: v('--panel'), panel2: v('--panel-2'), bg: v('--bg'),
          sky: v('--sky'), skyInk: v('--sky-ink'), skyMuted: v('--sky-muted'), skySun: v('--sky-sun'), skyEarth: v('--sky-earth'), terrain: v('--terrain'), crest: v('--terrain-crest'), skyGo: v('--sky-go'), skyWarn: v('--sky-warn'), skyBad: v('--sky-bad'),
          seq: [1, 2, 3, 4, 5, 6].map(k => v('--seq-' + k)) };
    HATCH = {};
  }
  // Chart text: numbers (ticks, readouts, tags) in IBM Plex Mono, labels (lane names, axis titles) in uppercase IBM Plex
  // Sans with wide tracking. Nothing on a chart is smaller than 12 px.
  const FONT = (px, w) => (w || 500) + ' ' + Math.max(12, px) + 'px "IBM Plex Mono", ui-monospace, Consolas, monospace';
  const FONTC = (px, w) => (w || 600) + ' ' + Math.max(12, Math.round(px * 0.92)) + 'px "IBM Plex Sans", system-ui, -apple-system, sans-serif';
  const FONTS = (px, w) => (w || 600) + ' ' + Math.max(12, px) + 'px "IBM Plex Sans", system-ui, -apple-system, sans-serif';
  // an uppercase label with the 0.06em tracking of the page's labels
  function labTxt(g, t, x, y, px) { g.font = FONTC(px || 13); if ('letterSpacing' in g) { g.letterSpacing = (0.06 * Math.max(12, px || 12)).toFixed(2) + 'px'; g.fillText(t.toUpperCase(), x, y); g.letterSpacing = '0px'; } else g.fillText(t.toUpperCase(), x, y); }
  function labW(g, t, px) { g.font = FONTC(px || 13); return g.measureText(t.toUpperCase()).width + t.length * 0.06 * Math.max(12, px || 12); }
  // the diagonal hatch that marks "marginal" everywhere: warn stripes on the given ground
  let HATCH = {};
  function hatch(g, ground) {
    const k = ground || C.cell; if (HATCH[k]) return HATCH[k];
    const t = document.createElement('canvas'); t.width = t.height = 6; const tg = t.getContext('2d');
    tg.fillStyle = k; tg.fillRect(0, 0, 6, 6); tg.strokeStyle = C.warn; tg.lineWidth = 2;
    tg.beginPath(); for (const o of [-6, 0, 6]) { tg.moveTo(o, 6); tg.lineTo(o + 6, 0); } tg.stroke();
    return HATCH[k] = g.createPattern(t, 'repeat');
  }
  // a rounded bar (the lanes, the calendar squares)
  function rbar(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.fill(); }
  // a filled tag with mono text: the clock tag, the lowest-point tag
  function pillTag(g, t, x, y, bg, fg, align) {
    g.font = FONT(12); const tw = g.measureText(t).width + 20, h = 24, lx = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
    g.fillStyle = bg; rbar(g, lx, y, tw, h, 4); g.fillStyle = fg; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(t, lx + 10, y + h / 2 + 0.5); return { x: lx, w: tw };
  }
  // verdict icons (tick, exclamation, cross) as inline SVG for badges
  const ICON = {
    2: '<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    1: '<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="M8 2.5v7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="13" r="1.3" fill="currentColor"/></svg>',
    0: '<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' };
  const VCLS = ['bad', 'warn', 'go'];
  const badge = (st, text) => '<span class="pill big ' + VCLS[st] + '">' + ICON[st] + (text || STL[st]) + '</span>';
  const offBadge = text => '<span class="pill big off">' + text + '</span>';
  const stBadge = st => '<span class="st s' + st + '">' + ICON[st] + STN[st] + '</span>';
  const shown = el => el.offsetParent !== null;
  function prep(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g, w, h };
  }
  function waiting(cv, text) { if (!shown(cv)) return; const { g, w, h } = prep(cv); g.fillStyle = C.muted; g.font = FONTS(13, 400); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text || 'Loading…', w / 2, Math.min(h / 2, 40)); }

  // ---------- the loaded window: hourly data from calAnchor, long enough for the chosen span plus a lunar day ----------
  // 120 days normally (about 1 MB less per site than a full year), 400 days when the one-year span is on screen.
  const TAB = { t0: 0, n: 120 * 24, days: 120 };
  function ensureTab() {
    const days = S.span >= 365 ? 400 : 120;
    if (S.anchor < S.calAnchor || S.anchor + (S.span + Math.max(45, S.cfg.days + 2)) * DAY > S.calAnchor + days * DAY) S.calAnchor = S.anchor;
    TAB.t0 = S.calAnchor; TAB.days = days; TAB.n = days * 24;
  }
  const idx = t => Math.round((t - TAB.t0) / HOUR);
  // Hourly Sun and Earth series plus the horizon for one site (server: /series)
  function ser(site) {
    const key = 'ser|' + siteKey(site) + '|' + S.eye + '|' + TAB.t0 + '|' + TAB.n;
    return need(key, async () => {
      const j = await getJSON('/series?' + qs({ ...loc(site), start: iso(TAB.t0), hours: TAB.n - 1, array_height_m: S.eye, antenna_height_m: S.eye }));
      const o = { n: j.n }; for (const k in j.series) o[k] = Float32Array.from(j.series[k]);
      const sk = j.horizon; o.mask = Float32Array.from(sk.sun); o.emask = Float32Array.from(sk.earth); o.h0 = sk.ground_m; o.tiers = sk.tiers; o.lo = sk.lo_deg; o.hi = sk.hi_deg;
      o.sources = j.meta && j.meta.sources; return o;
    });
  }
  // Hourly Sun and Earth vectors, Moon-fixed (server: /ephemeris), for the globe, the shadow map and sub-points
  function eph() {
    return need('eph|' + TAB.t0 + '|' + TAB.n, async () => {
      const j = await getJSON('/ephemeris?' + qs({ start: iso(TAB.t0), hours: TAB.n - 1 }));
      return { n: j.n, sun: Float64Array.from(j.sun_km.flat()), earth: Float64Array.from(j.earth_km.flat()) };
    });
  }
  function bodyAt(t) {
    const e = eph(); if (!e) return null;
    const x = Math.max(0, Math.min(e.n - 1.0001, (t - TAB.t0) / HOUR)), i = Math.floor(x), f = x - i, L = (a, k) => a[i * 3 + k] * (1 - f) + a[(i + 1) * 3 + k] * f;
    return { sun: [L(e.sun, 0), L(e.sun, 1), L(e.sun, 2)], earth: [L(e.earth, 0), L(e.earth, 1), L(e.earth, 2)] };
  }
  // Sun and Earth state at any instant, interpolated between the server's hourly values (playback, other sites)
  function stateAt(se, t) {
    const x = (t - TAB.t0) / HOUR; if (!se || x < 0 || x > se.n - 1) return null;
    const i = Math.min(se.n - 2, Math.floor(x)), f = x - i, L = a => a[i] * (1 - f) + a[i + 1] * f;
    const sunEl = L(se.sunEl), sunClr = L(se.sunClr), earthEl = L(se.earthEl), earthClr = L(se.earthClr);
    return { sunEl, sunAz: lerpAz(se.sunAz[i], se.sunAz[i + 1], f), sunRad: L(se.sunRad), sunHz: sunEl - sunClr, sunClr, sunFrac: L(se.sunFrac),
             earthEl, earthAz: lerpAz(se.earthAz[i], se.earthAz[i + 1], f), earthRad: 0.95, earthHz: earthEl - earthClr, earthClr, h0: se.h0, irr: L(se.irr) };
  }
  // The exact state now, with the next sunset/sunrise, Earthset/Earthrise and the DSN view (server: /sky)
  let skyTimer = 0, skyWant = null;
  function skyExact() {
    const key = 'sky|' + siteKey(S.site) + '|' + S.eye + '|' + S.t, e = cache.get(key);
    if (e && e.v) return e.v;
    if (!S.playing && !S.scrubbing && skyWant !== key) { skyWant = key; clearTimeout(skyTimer); skyTimer = setTimeout(() => need(key, () => getJSON('/sky?' + qs({ ...loc(S.site), time: iso(S.t), array_height_m: S.eye, antenna_height_m: S.eye }))), 120); }
    return null;
  }
  const evOf = ev => ev && ev.time ? { t: Date.parse(ev.time) } : null;
  function siteMask(site) { const se = ser(site); return se ? { mask: se.mask, h0: se.h0, lo: se.lo, hi: se.hi, tiers: se.tiers } : null; }
  function tierText(m) {
    const t = (m.tiers || []).filter(x => x !== 'LOLA coarse grid' || m.tiers.length === 1);
    return 'horizon from the ' + (t.length ? t.join(', then ') : 'LOLA coarse grid') + ' terrain';
  }

  // ---------- what is asked of the server for the mission panels ----------
  // ---------- lander presets (server: /landers) ----------
  let LANDERS = [];
  const presetOf = id => (LANDERS.find(l => l.id === id) || {}).spec || null;
  // Vertical (side-mounted) panels: keep the preset's face layout and scale it to the total output in the form.
  function facesFor(total) {
    const p = presetOf(S.landerId), f = p && p.power.array.type === 'vertical' ? p.power.array.faces : [0, 90, 180, 270].map(a => ({ azimuth_deg: a, peak_w: 1 }));
    const sum = f.reduce((a, x) => a + x.peak_w, 0) || 1;
    return f.map(x => ({ azimuth_deg: x.azimuth_deg, peak_w: total * x.peak_w / sum }));
  }
  function arrayOf(c) {
    if (c.arrayType === 'vert') return { type: 'vertical', peak_w: null, faces: facesFor(c.peakW), heading_deg: 0, height_m: S.eye };
    return { type: c.arrayType === 'track' ? 'tracking' : 'horizontal', peak_w: c.peakW, height_m: S.eye };
  }
  // Share of full output the array gives for a Sun at this elevation and azimuth (before terrain and distance)
  function arrayShape(c, el, az) {
    if (c.arrayType === 'track') return 1;
    if (c.arrayType === 'flat') return Math.max(0, Math.sin(el * D2R));
    const f = facesFor(1); return f.reduce((a, x) => a + x.peak_w * Math.max(0, Math.cos(el * D2R) * Math.cos((az - x.azimuth_deg) * D2R)), 0);
  }
  const ARRN = { track: 'sun-tracking', vert: 'side-mounted', flat: 'flat' };
  function lander() {
    const c = S.cfg;
    return { base: S.landerId, id: 'web', name: 'Lander from the web page', source: 'illustrative',
             power: { array: { ...arrayOf(c), ...(c.strict ? { incidence_loss: true } : {}) },
                      battery: { capacity_wh: c.capWh, min_soc: c.minSoc, charge_eff: c.chargeEff, ...(c.strict ? { discharge_eff: 0.95 } : {}) },
                      loads: { sunlit_w: c.loadSun, dark_w: c.loadDark }, safe_mode: c.safe },
             comms: { antenna_height_m: S.eye }, landing: { accuracy_m_3sigma: S.acc, max_slope_deg: S.sig.slope },
             // heat model (off by default): the server's one-node heat balance with its default body
             ...(c.heat ? { thermal: {} } : {}) };
  }
  function missionSpec() { const c = S.cfg; return { duration_days: c.days, needs_earth: c.needEarth, use_dsn: c.needEarth && c.useDsn, max_gap_h: c.maxGapH, autonomy_h: c.autonomyH, terrain_margin_deg: c.margin, fault: c.fault,
    // stricter physics (off by default): the whole Earth disc must clear the terrain, and the Sun is dimmer at its edge
    ...(c.strict ? { link_min_clearance_deg: 0.95, limb_darkening: 0.6 } : {}) }; }
  const landingTime = () => floorHour(S.t);
  const sumOf = x => x && { ok: x.ok, fails: x.fails, minSoc: x.min_soc, kMin: x.min_soc_at_h, kFail: x.below_reserve_at_h === null ? -1 : x.below_reserve_at_h, maxGapH: x.longest_link_gap_h,
    maxDarkH: x.longest_dark_h, linkPct: x.link_pct, litPct: x.lit_pct, battNeedWh: x.battery_needed_wh === null ? Infinity : x.battery_needed_wh, n: x.hours_simulated, safeH: x.safe_mode_hours, heat: x.thermal || null,
    faultK: x.fault_starts_at_h === null ? -1 : x.fault_starts_at_h };
  function missionNow() {
    const body = { location: loc(S.site), landing_time: iso(landingTime()), lander: lander(), mission: missionSpec(), include: ['trace'] }, key = 'mis|' + JSON.stringify(body);
    const q = latest('mission', key, sig => getJSON('/mission', body, sig)), r = q.v; if (!r) return { pending: true, err: q.err };
    const nom = sumOf(r.nominal), rob = sumOf(r.with_terrain_margin), st = { meets: 2, marginal: 1, fails: 0 }[r.verdict];
    nom.soc = r.trace.state_of_charge; nom.sun = r.trace.sun_share; nom.link = r.trace.earth_link; nom.safeArr = r.trace.safe_mode; rob.soc = r.trace.state_of_charge_with_margin;
    return { nom, rob, st, t: Date.parse(r.landing_time), stress: r.stress || null, reasons: r.reasons, stale: !q.fresh, err: q.err };
  }

  // ---------- plan: contingencies ----------
  const FAULTS = {
    none: 'The mission as planned, with nothing going wrong.',
    array: 'Could happen if dust thrown up by the landing settles on the panels, a panel only partly deploys, or a string of cells fails.',
    load: 'Could happen if a heater sticks on in the cold, or an instrument will not power down after a software fault.',
    battery: 'Could happen if a cell fails, or the battery runs colder than planned, which cuts the energy it can deliver.',
    antenna: 'Could happen after a computer reset that loses antenna pointing, a radio fault, or when the ground stations are booked by other missions.',
    custom: 'Set your own mix below. The solar, load and battery effects last to the end of the mission; the contact outage lasts the hours you give.' };
  function faultName(f) {
    if (f.kind === 'array') return 'solar output is 30% lower';
    if (f.kind === 'load') return 'an extra 100 W load stays on';
    if (f.kind === 'battery') return 'the battery holds 25% less';
    if (f.kind === 'antenna') return 'there is no Earth contact for 24 hours';
    const p = [];
    if (f.array_loss_pct) p.push('solar output is ' + f.array_loss_pct + '% lower');
    if (f.extra_load_w) p.push('an extra ' + f.extra_load_w + ' W load stays on');
    if (f.battery_loss_pct) p.push('the battery holds ' + f.battery_loss_pct + '% less');
    if (f.comms_outage_h) p.push('there is no Earth contact for ' + f.comms_outage_h + ' h');
    return p.length ? p.join(', ') : 'nothing changes (all custom values are zero)';
  }

  // ---------- plan: mission verdict and survival timeline ----------
  function drawMission() {
    const mv = missionNow(), cfg = S.cfg, ban = $('mv-ban');
    $('mv-mlab').textContent = cfg.margin;
    const setBan = (st, title) => { ban.className = 'verdict' + (st === null ? '' : ' s' + st); $('mv-ic').innerHTML = st === null ? '' : ICON[st]; $('mv-pill').textContent = title; };
    if (mv.pending) { S.mv = null; setBan(null, mv.err ? 'Server error' : 'Simulating…'); $('mv-say').textContent = mv.err || ''; waiting($('surv'), mv.err ? ' ' : 'Simulating the mission…'); return; }
    S.mv = mv; const { nom, rob, st } = mv;
    if (mv.stale) setBan(null, mv.err ? 'Server error' : 'Updating…'); else setBan(st, ['Fails', 'Marginal', 'Meets the needs'][st]);
    const where = short(S.site) + ', landing ' + fmtDT(mv.t) + ', ' + cfg.days + '-day mission: ';
    $('mv-say').textContent = where + (st === 2 ? 'power and Earth contact last the whole mission, even with every horizon raised by ' + cfg.margin + '°.'
      : st === 1 ? 'it works on the mapped terrain, but with horizons raised by ' + cfg.margin + '° ' + rob.fails.join(' and ') + '.'
      : nom.fails.join(', and ') + '.')
      + (nom.heat ? (nom.heat.heater_hours ? ' Heaters ran for ' + nom.heat.heater_hours + ' h and used ' + fmtCap(nom.heat.heater_wh) + ' to hold the electronics at ' + Math.round(nom.heat.coldest_c) + ' °C.' : ' The heaters were never needed: the coldest the electronics got was ' + Math.round(nom.heat.coldest_c) + ' °C.') : '');
    $('mv-soc').textContent = Math.round(nom.minSoc * 100) + '%'; $('mv-soc-s').textContent = 'Reserve is ' + Math.round(cfg.minSoc * 100) + '% · day ' + (nom.kMin / 24).toFixed(1) + ' · with margin ' + Math.round(rob.minSoc * 100) + '%';
    $('mv-lit').textContent = fmtH(nom.maxDarkH); $('mv-lit-s').textContent = 'Sunlit ' + nom.litPct.toFixed(0) + '% of the mission · with margin ' + rob.litPct.toFixed(0) + '%';
    $('mv-gap').textContent = fmtH(nom.maxGapH); $('mv-gap-s').textContent = (cfg.needEarth ? 'Limit is ' + cfg.maxGapH + ' h' : 'No direct link required') + ' · contact ' + nom.linkPct.toFixed(0) + '% of the time';
    $('mv-need').textContent = fmtWh(nom.battNeedWh); $('mv-need-s').textContent = 'Fitted ' + fmtWh(cfg.capWh) + ', to ride out the longest shortfall';
    const FN = faultName(cfg.fault);
    $('c-pill').innerHTML = cfg.fault.kind === 'none' ? '' : mv.stale ? offBadge('Updating…') : nom.ok ? badge(2, 'Survives') : badge(0, 'Does not survive');
    if (cfg.fault.kind === 'none') $('mv-fault').textContent = cfg.safe && nom.safeH ? 'Safe mode was needed for ' + nom.safeH + ' h even with nothing going wrong.' : '';
    else if (mv.stress) {
      const clean = mv.stress.without_fault, other = mv.stress.safe_mode_toggled, out = r => r.ok ? 'the mission survives' : 'the mission fails (' + r.fails[0] + ')';
      $('mv-fault').textContent = 'From mission day ' + cfg.fault.day + ', ' + FN + '. ' + (clean.ok ? 'Without the fault the mission passes. ' : 'The mission fails even without the fault. ')
        + (cfg.safe ? 'With safe mode ' + out(nom) + (nom.safeH ? ', spending ' + nom.safeH + ' h at reduced power' : ', and safe mode is never triggered') + '. Without it ' + out(other) + '.'
                    : 'Without safe mode ' + out(nom) + '. With it ' + out(other) + (other.safe_mode_hours ? ', at the cost of ' + other.safe_mode_hours + ' h at reduced power.' : '.'));
    }
    const cv = $('surv'); if (!shown(cv)) return;
    // two yes/no lanes, then the battery chart: nights shaded, the reserve as a red band, the lowest point tagged
    const { g, w, h } = prep(cv), narrow = w < 600, px = narrow ? 84 : 150, pr = narrow ? 64 : 84, pw = w - px - pr, n = nom.n;
    const ln = 14, l1 = 6, l2 = l1 + ln + 8, bt = l2 + ln + 20, bb = h - 34, bh = bb - bt;
    const X = k => px + k / Math.max(1, n) * pw, Y = v => bt + (1 - v) * bh;
    const lane = (y, pred, alpha, col, name) => {
      g.fillStyle = C.cell; rbar(g, px, y, pw, ln, 3);
      let s = -1; for (let k = 0; k <= n; k++) { const on = k < n && pred(k); if (on && s < 0) s = k; if (!on && s >= 0) { g.fillStyle = col; g.globalAlpha = alpha ? alpha(s, k) : 1; rbar(g, X(s), y, Math.max(1.5, X(k) - X(s)), ln, 3); g.globalAlpha = 1; s = -1; } }
      g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'middle'; labTxt(g, name, px - 8, y + ln / 2 + 1, 12);
    };
    lane(l1, k => nom.sun[k] > 0, (a, b) => { let m = 0; for (let k = a; k < b; k++) m += nom.sun[k]; return 0.45 + 0.55 * m / (b - a); }, C.sun, 'Sunlight');
    lane(l2, k => !!nom.link[k], null, C.earth, cfg.useDsn && cfg.needEarth ? 'Contact' : 'Earth in view');
    // nights behind the curve
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = FONT(12);
    let s0 = -1; for (let k = 0; k <= n; k++) { const dark = k < n && !(nom.sun[k] > 0); if (dark && s0 < 0) s0 = k; if (!dark && s0 >= 0) { const xa = X(s0), xb = X(k); g.fillStyle = C.cell; g.globalAlpha = 0.6; g.fillRect(xa, bt, xb - xa, bh); g.globalAlpha = 1; if (xb - xa > 44) { g.fillStyle = C.muted; g.fillText('night', (xa + xb) / 2, bt + 16); } s0 = -1; } }
    g.fillStyle = C.warn; g.globalAlpha = 0.18; for (let k = 0; k < n; k++) if (nom.safeArr[k]) g.fillRect(X(k), bt, pw / n + 0.5, bh); g.globalAlpha = 1;
    g.font = FONT(12); g.textBaseline = 'middle';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) { g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(px, Y(v)); g.lineTo(px + pw, Y(v)); g.stroke(); g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(Math.round(v * 100) + '%', px - 8, Y(v)); }
    if (!narrow) { g.fillStyle = C.muted; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; labTxt(g, 'Battery', 0, bt + 12, 12); labTxt(g, 'Charge', 0, bt + 28, 12); }
    // the reserve band
    g.fillStyle = C.bad; g.globalAlpha = 0.14; g.fillRect(px, Y(cfg.minSoc), pw, Y(0) - Y(cfg.minSoc)); g.globalAlpha = 1;
    g.setLineDash([6, 4]); g.strokeStyle = C.bad; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, Y(cfg.minSoc)); g.lineTo(px + pw, Y(cfg.minSoc)); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.bad; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; labTxt(g, 'Reserve', px + pw + 8, Y(cfg.minSoc) + 4, 12); g.font = FONT(12); g.fillText(Math.round(cfg.minSoc * 100) + '%', px + pw + 8, Y(cfg.minSoc) + 20);
    const line = (soc, col, lw, dash) => { g.beginPath(); for (let k = 0; k <= n; k++) { k ? g.lineTo(X(k), Y(soc[k])) : g.moveTo(X(k), Y(soc[k])); } g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(dash); g.lineJoin = 'round'; g.stroke(); g.setLineDash([]); };
    line(rob.soc, C.muted, 1.5, [5, 4]); line(nom.soc, C.ink, 2.5, []);
    if (nom.faultK >= 0 && nom.faultK <= n) { const x = X(nom.faultK); g.setLineDash([2, 3]); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, bt); g.lineTo(x, bb); g.stroke(); g.setLineDash([]); g.fillStyle = C.ink; g.textBaseline = 'top'; const rt = x > px + pw - 60; g.textAlign = rt ? 'right' : 'left'; labTxt(g, 'Fault', x + (rt ? -5 : 5), bt + 46, 12); }
    if (nom.kFail > 0) { const x = X(nom.kFail); g.strokeStyle = C.bad; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, bt); g.lineTo(x, bb); g.stroke(); g.fillStyle = C.bad; g.textBaseline = 'top'; const rt = x > px + pw - 150; g.textAlign = rt ? 'right' : 'left'; labTxt(g, 'Reserve breached', x + (rt ? -5 : 5), bt + 26, 12); }
    // the lowest point, tagged; the terrain-margin case gets its own lowest value in words
    const kMin = Math.max(0, Math.min(n, nom.kMin)), mx = X(kMin), my = Y(nom.minSoc);
    const tag = 'Lowest ' + Math.round(nom.minSoc * 100) + '% · day ' + (kMin / 24).toFixed(1);
    g.font = FONT(12); const tw = g.measureText(tag).width + 20, tx = mx + 12 + tw > px + pw ? mx - 12 - tw : mx + 12, above = my - 34 >= bt + 2, ty = above ? my - 34 : Math.min(bb - 26, my + 10);
    pillTag(g, tag, tx, ty, C.ink, C.bg);
    g.beginPath(); g.arc(mx, my, 5, 0, 7); g.fillStyle = C.panel; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.5; g.stroke();
    if (cfg.margin > 0 && Math.round(rob.minSoc * 100) !== Math.round(nom.minSoc * 100)) { let kr = 0; for (let k = 0; k <= n; k++) if (rob.soc[k] < rob.soc[kr]) kr = k; const rt = 'terrain ' + cfg.margin + '° higher: ' + Math.round(rob.minSoc * 100) + '%'; g.font = FONT(12); const rw = g.measureText(rt).width, rx = Math.max(px + 4, Math.min(px + pw - rw - 4, X(kr) + 10)); let ry = Math.min(bb - 6, Y(rob.soc[kr]) + 20); if (ry > ty - 4 && ry - 14 < ty + 28 && rx < tx + tw && rx + rw > tx) ry = ty + 44 < bb ? ty + 44 : ty - 8;
      g.lineWidth = 4; g.strokeStyle = C.panel; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.strokeText(rt, rx, ry); g.fillStyle = C.muted; g.fillText(rt, rx, ry); }
    // days along the bottom
    g.font = FONT(12); g.fillStyle = C.muted; g.textBaseline = 'top'; const days = n / 24, per = pw / Math.max(1, days), stepD = [1, 2, 5, 10, 20].find(v => v * per >= 56) || 30;
    for (let d = 0; d <= days + 1e-9; d++) { const x = X(d * 24); g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(x, bb); g.lineTo(x, bb + 5); g.stroke(); if (d % stepD && d < days - 0.01) continue; if (d > 0 && d < days - 0.01 && (days - d) * per < 50) continue; g.textAlign = d === 0 ? 'left' : d >= days - 0.01 ? 'right' : 'center'; g.fillText(d === 0 ? 'Landing' : 'Day ' + d, x, bb + 10); }
  }
  // ---------- plan: mission design (sizing, server: /design) ----------
  const LAB = { F: null, atlas: null, geo: null, ageo: null, res: null, cb: null, pa: null };
  const fmtW = p => Math.round(p).toLocaleString('en-US') + ' W', fmtCap = c => fmtWh(c);
  function setHardware(p, c) { if (p != null) $('m-peak').value = Math.round(p); if (c != null) $('m-cap').value = Math.round(c); S.landerEdited = true; readCfg(); }
  function labNow() {
    const body = { location: loc(S.site), landing_time: iso(landingTime()), lander: lander(), mission: missionSpec(),
                   atlas_start: iso(Math.max(TAB.t0, floorDay(S.t) - 5 * DAY)) }, key = 'lab|' + JSON.stringify(body);
    const q = latest('design', key, sig => getJSON('/design', body, sig)); return { r: q.v, err: q.err, stale: !q.fresh };
  }
  function drawLab() {
    const cv = $('dfront'); if (!shown(cv)) return;
    const q = labNow(), R = q.r, cfg = S.cfg;
    if (!R || !S.mv || S.mv.pending) { $('d-pill').innerHTML = offBadge(q.err ? 'Server error' : 'Working…'); waiting(cv, q.err || 'Trying solar and battery sizes…'); waiting($('datlas'), ' '); return; }
    LAB.res = R; LAB.F = R.frontier; const F = R.frontier, st = S.mv.st, stale = q.stale || S.mv.stale, any = F.rob.some(v => v !== null);
    const cb = R.min_battery_at_your_array_wh, pa = R.min_array_at_your_battery_w;
    LAB.cb = cb == null ? null : Math.ceil((cb - 1e-3) / 10) * 10; LAB.pa = pa == null ? null : Math.ceil(pa / 5) * 5;
    const diff = (have, need, f) => have >= need ? f(have - need) + ' to spare' : f(need - have) + ' short';
    if (!any) {
      $('d-cb').textContent = 'None'; $('d-pa').textContent = 'None';
      $('d-cb-s').textContent = 'No combination works for this landing time: ' + (R.why_none || 'the mission cannot be met') + '. Try another date below.'; $('d-pa-s').textContent = '';
    } else {
      $('d-cb').textContent = LAB.cb === null ? 'No size works' : fmtWh(LAB.cb);
      $('d-cb-s').textContent = LAB.cb === null ? 'With ' + fmtW(cfg.peakW) + ' of solar, no battery is big enough.' : 'With your ' + fmtW(cfg.peakW) + ' of solar. You have ' + fmtWh(cfg.capWh) + ': ' + diff(cfg.capWh, LAB.cb, fmtWh) + '.';
      $('d-pa').textContent = LAB.pa === null ? 'No size works' : fmtW(LAB.pa);
      $('d-pa-s').textContent = LAB.pa === null ? 'With a ' + fmtWh(cfg.capWh) + ' battery, no amount of solar is enough.' : 'With your ' + fmtWh(cfg.capWh) + ' battery. You have ' + fmtW(cfg.peakW) + ': ' + diff(cfg.peakW, LAB.pa, fmtW) + '.';
    }
    $('d-cb-go').disabled = LAB.cb === null || stale; $('d-pa-go').disabled = LAB.pa === null || stale;
    $('d-pill').innerHTML = stale ? offBadge(q.err ? 'Server error' : 'Updating…')
      : !any ? badge(0, 'No size works at this time') : badge(st, ['Your lander falls short', 'Marginal', 'Your lander passes'][st]);
    const x = R.max_sunlit_load_w;
    $('d-alt').innerHTML = any && st < 2 ? '<ul class="alts"><li>' + (x === null || x === undefined || x < 1 ? 'Cutting power use in sunlight alone would not be enough with this hardware.' : 'Or keep the hardware and cut power use in sunlight from ' + fmtW(cfg.loadSun) + ' to ' + fmtW(Math.floor(x)) + '.') + '</li></ul>' : '';
    // pass/fail chart: solar output against battery size
    const { g, w, h } = prep(cv), L = 66, Rm = 12, T = 12, B = 34, pw = w - L - Rm, ph = h - T - B, x0 = Math.log(60), x1 = Math.log(60000), y0 = Math.log(20), y1 = Math.log(F.pMax);
    const X = c => L + (Math.log(c) - x0) / (x1 - x0) * pw, Y = p => T + (1 - (Math.log(Math.max(20, Math.min(F.pMax, p))) - y0) / (y1 - y0)) * ph;
    LAB.geo = { L, T, pw, ph, x0, x1, y0, y1 };
    g.fillStyle = C.cell; g.fillRect(L, T, pw, ph);
    const region = (lower, fill, alpha) => { const idx = F.caps.map((_, k) => k).filter(k => lower[k] !== null); if (!idx.length) return null; g.beginPath(); idx.forEach((k, j) => { const xx = X(F.caps[k]), yy = Y(lower[k]); j ? g.lineTo(xx, yy) : g.moveTo(xx, yy); }); for (let j = idx.length - 1; j >= 0; j--) g.lineTo(X(F.caps[idx[j]]), T); g.closePath(); g.fillStyle = fill; g.globalAlpha = alpha; g.fill(); g.globalAlpha = 1; return idx; };
    region(F.nom, hatch(g, C.cell), 1); region(F.rob, C.cell, 1); const ridx = region(F.rob, C.go, 0.35);
    const line = (arr, col, lw, dash) => { g.beginPath(); let pen = false; F.caps.forEach((c, k) => { if (arr[k] === null) { pen = false; return; } const xx = X(c), yy = Y(arr[k]); pen ? g.lineTo(xx, yy) : g.moveTo(xx, yy); pen = true; }); g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
    line(F.nom, C.warn, 1.5, [5, 4]); line(F.rob, C.go, 2.5);
    // name the two regions on the chart
    g.textBaseline = 'middle'; g.textAlign = 'left';
    if (ridx && ridx.length) { const k = ridx[Math.floor(ridx.length * 0.7)], xx = Math.min(L + pw - 70, X(F.caps[k])), yy = Math.max(T + 30, (T + Y(F.rob[k])) / 2); g.fillStyle = C.go; labTxt(g, 'Passes', xx, yy, 12); }
    g.fillStyle = C.muted; labTxt(g, 'Fails', L + 10, T + ph - 14, 12);
    g.font = FONT(12); g.fillStyle = C.muted; g.strokeStyle = C.line; g.lineWidth = 1; g.textAlign = 'center'; g.textBaseline = 'top';
    [[100, '100 Wh'], [1000, '1 kWh'], [10000, '10 kWh']].forEach(([c, t]) => { g.beginPath(); g.moveTo(X(c), T + ph); g.lineTo(X(c), T + ph + 5); g.stroke(); g.fillText(t, X(c), T + ph + 8); });
    g.textAlign = 'right'; g.textBaseline = 'middle'; [50, 100, 200, 500, 1000, 2000, 5000].forEach(pp => { if (pp > F.pMax) return; g.beginPath(); g.moveTo(L - 5, Y(pp)); g.lineTo(L, Y(pp)); g.stroke(); g.fillText(pp + ' W', L - 8, Y(pp)); });
    g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; labTxt(g, 'Battery capacity', L + pw, T + ph + 32, 12); g.textAlign = 'left'; g.textBaseline = 'top'; labTxt(g, 'Solar output', L + 8, T + 7, 12);
    const tagAt = (t, xx, yy) => { g.font = FONTS(13); const tw = g.measureText(t).width, lx = xx + 10 + tw > L + pw ? xx - 10 - tw : xx + 10; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 4; g.strokeStyle = C.panel; g.strokeText(t, lx, yy); g.fillStyle = C.ink; g.fillText(t, lx, yy); };
    const dot = (xx, yy) => { g.beginPath(); g.arc(xx, yy, 4.5, 0, 7); g.fillStyle = C.go; g.fill(); g.strokeStyle = C.panel; g.lineWidth = 2; g.stroke(); };
    const cx = X(Math.max(60, Math.min(60000, cfg.capWh))), cy = Y(cfg.peakW);
    g.setLineDash([3, 3]); g.strokeStyle = C.muted; g.lineWidth = 1;
    if (LAB.cb !== null) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(X(Math.max(60, Math.min(60000, LAB.cb))), cy); g.stroke(); }
    if (LAB.pa !== null) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, Y(LAB.pa)); g.stroke(); }
    g.setLineDash([]);
    if (LAB.cb !== null) dot(X(Math.max(60, Math.min(60000, LAB.cb))), cy);
    if (LAB.pa !== null) dot(cx, Y(LAB.pa));
    g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fillStyle = C.panel; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.5; g.stroke(); tagAt('Your lander', cx, cy + 15);
    drawAtlas(R);
  }
  function drawAtlas(R) {
    const cv = $('datlas'), cfg = S.cfg, Bw = R.atlas_battery_wh || [], ST = R.atlas_state || [], NA = Bw.length, t0 = Date.parse(R.atlas_start), span = NA * R.atlas_step_h / 24, step = R.atlas_step_h * HOUR;
    LAB.atlas = { t0, step };
    const { g, w, h } = prep(cv), L = 76, Rm = 10, T = 12, ch = h - T - 32, pw = w - L - Rm;
    let mx = cfg.capWh; for (const v of Bw) if (v !== null && v > mx) mx = v; mx *= 1.15;
    const X = j => L + j / NA * pw, Y = v => T + (1 - v / mx) * ch; LAB.ageo = { L, pw, NA };
    const raw = mx / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), stepV = [1, 2, 5, 10].map(m => m * mag).find(v => v >= raw);
    g.font = FONT(12); g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = 0; v <= mx; v += stepV) { g.strokeStyle = v === 0 ? C.line2 : C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke(); g.fillStyle = C.muted; g.fillText(fmtWh(v), L - 8, Y(v)); }
    // bars in the verdict colours; marginal is hatched so it reads without colour
    const bw = Math.max(1, pw / NA - 1);
    for (let j = 0; j < NA; j++) {
      if (Bw[j] === null) { g.fillStyle = C.cell; g.globalAlpha = 0.7; g.fillRect(X(j), T, pw / NA + 0.5, ch); g.globalAlpha = 1; continue; }
      const s = ST[j] || 0; g.fillStyle = s === 1 ? hatch(g, C.panel) : s === 2 ? C.go : C.bad; g.fillRect(X(j) + 0.5, Y(Bw[j]), bw, Y(0) - Y(Bw[j]));
    }
    g.setLineDash([5, 4]); g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(L, Y(cfg.capWh)); g.lineTo(L + pw, Y(cfg.capWh)); g.stroke(); g.setLineDash([]);
    const yl = 'Your battery ' + fmtWh(cfg.capWh); g.textAlign = 'left'; g.textBaseline = 'bottom'; const lw = labW(g, yl, 12) + 12; g.fillStyle = C.panel; g.globalAlpha = 0.85; g.fillRect(L + 2, Y(cfg.capWh) - 19, lw, 16); g.globalAlpha = 1; g.fillStyle = C.ink; labTxt(g, yl, L + 8, Y(cfg.capWh) - 4, 12);
    timeAxis(g, L, T + ch + 2, pw, t0, span);
    const cx = L + (S.t - t0) / (span * DAY) * pw; if (cx >= L && cx <= L + pw) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ch); g.stroke(); }
    const order = []; for (let j = 0; j < NA; j++) if (Bw[j] !== null) order.push(j); order.sort((a, b) => Bw[a] - Bw[b]);
    const top = []; for (const j of order) { if (top.every(q => Math.abs(q - j) >= 6)) top.push(j); if (top.length === 4) break; }
    $('d-tbl').innerHTML = top.length ? '<thead><tr><th>Land on</th><th>Battery needed</th><th>Your lander as it is</th><th></th></tr></thead><tbody>' + top.map(j => '<tr><td>' + fmtDT(t0 + j * step).replace(' UTC', '') + '</td><td>' + fmtWh(Bw[j]) + '</td><td>' + stBadge(ST[j]) + '</td><td><button type="button" data-ai="' + j + '">Go to this date</button></td></tr>').join('') + '</tbody>'
      : '<tbody><tr><td>No landing time in these 60 days works with any battery size, with the solar panels this lander has.</td></tr></tbody>';
  }

  // ---------- plan: landing risk (Monte Carlo, server: /mission with risk) ----------
  const CAUSES = ['Dark at landing', 'No Earth line of sight at landing', 'Battery too low', 'Link gap too long', 'Ground too steep', 'Other'];
  const CKEYS = ['dark_at_landing', 'no_earth_at_landing', 'battery_too_low', 'link_gap_too_long', 'ground_too_steep', 'other'];
  const riskOk = () => S.site.lat <= -80.05;
  const riskBody = () => ({ location: loc(S.site), landing_time: iso(landingTime()), lander: lander(), mission: missionSpec(), risk: true,
    uncertainty: { time_3sigma_h: S.tjit, terrain_sigma_deg: S.sig.terrain, power_sigma_pct: S.sig.power, load_sigma_pct: S.sig.load, capacity_sigma_pct: S.sig.cap, cold_case_link: S.sig.corr, seed: S.sig.seed, accuracy_m_3sigma: S.acc, max_slope_deg: S.sig.slope } });
  const riskKey = () => 'risk|' + JSON.stringify(riskBody());
  const fmtDist = km => km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
  let riskLast = null, riskMemo = { key: null, r: null };
  function riskNow() {
    if (!riskOk()) return null;
    const key = riskKey(), body = riskBody(), q = latest('risk', key, sig => getJSON('/mission', body, sig), 600), j = q.fresh ? q.v : null;
    if (j && riskMemo.key === key) return riskMemo.r;
    if (!j) return riskLast && riskLast.site === siteKey(S.site) ? Object.assign({}, riskLast, { stale: true, err: q.err }) : { pending: true, err: q.err };
    const k = j.risk, gd = k.grid, n = gd.n, sp = gd.spacing_m / 1000, W = gd.half_width_m / 1000, c = (n - 1) / 2;
    const rho0 = 2 * RM * Math.tan((90 + Math.max(-89.999, S.site.lat)) / 2 * D2R);
    let bi = 0, bd = 1e9; gd.lat.forEach((la, q) => { const d = Math.hypot(la - k.best_aim.lat, (gd.lon[q] - k.best_aim.lon) * Math.cos(la * D2R)); if (d < bd) { bd = d; bi = q; } });
    const r = { site: siteKey(S.site), n, sp, W, E: W + sp / 2, Rkm: k.settings.accuracy_m_3sigma / 1000, x0: rho0 * Math.sin(S.site.lon * D2R), y0: rho0 * Math.cos(S.site.lon * D2R),
      P: gd.success, det: gd.deterministic, lat: gd.lat, lon: gd.lon, slope: gd.slope_deg, p: k.success_p, lo: k.ci95[0], hi: k.ci95[1], causes: CKEYS.map(q => k.causes[q]),
      best: { ix: bi % n, iy: Math.floor(bi / n), p: k.best_aim.p, lo: k.best_aim.lo, hi: k.best_aim.hi, clear: k.best_aim.clear, dist: k.best_aim.distance_m / 1000, bearing: k.best_aim.bearing_deg, lat: k.best_aim.lat, lon: k.best_aim.lon },
      drivers: k.drivers.map(d => [d.if, d.success_p]), total: k.total_missions, seconds: k.seconds, landing: Date.parse(j.landing_time), bg: null, ci: c };
    riskLast = r; riskMemo = { key, r }; return r;
  }
  // the six-step ramp for a chance of success: 0-20, 20-40, 40-60, 60-80, 80-95, 95%+
  const seqOf = p => C.seq[p >= 0.95 ? 5 : p >= 0.8 ? 4 : Math.max(0, Math.min(3, Math.floor(p * 5)))];
  // a boxed tag on a night scene: sky ground, sky ink, mono text
  function skyTag(g, t, x, y, w, opts) {
    const o = opts || {}; g.font = FONT(12); const tw = g.measureText(t).width + 16, h = 22;
    let lx = o.left ? x - 12 - tw : x + 12; if (lx + tw > w - 4) lx = x - 12 - tw; if (lx < 4) lx = Math.min(w - tw - 4, x + 12);
    const ty = Math.max(4, Math.min((o.h || w) - h - 4, y - h / 2));
    g.fillStyle = C.sky; g.globalAlpha = 0.9; rbar(g, lx, ty, tw, h, 4); g.globalAlpha = 1;
    if (o.stroke) { g.strokeStyle = o.stroke; g.globalAlpha = 0.7; g.lineWidth = 1; g.beginPath(); g.roundRect ? g.roundRect(lx + 0.5, ty + 0.5, tw - 1, h - 1, 4) : g.rect(lx, ty, tw, h); g.stroke(); g.globalAlpha = 1; }
    g.fillStyle = o.col || C.skyInk; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(t, lx + 8, ty + h / 2 + 0.5);
  }
  function drawRisk() {
    const cv = $('risk'), r = riskNow(), cur = r && !r.pending && !r.stale;
    if (!riskOk()) {
      $('k-pill').innerHTML = ''; ['k-p', 'k-det', 'k-best'].forEach(id => { $(id).textContent = '—'; }); ['k-p-s', 'k-det-s', 'k-best-s'].forEach(id => { $(id).textContent = ''; }); $('k-causes').innerHTML = ''; $('k-drivers').innerHTML = ''; $('k-go').disabled = true;
      $('k-cap').textContent = 'This analysis needs the polar terrain, which covers 80°S to the south pole. Pick a south-pole site to use it.'; $('k-msg').textContent = ''; $('k-say').textContent = '';
    } else if (r && !r.pending) {
      const pc = Math.round(r.p * 100), lvl = r.p >= 0.9 ? [2, 'Low risk'] : r.p >= 0.6 ? [1, 'Moderate risk'] : [0, 'High risk'];
      $('k-pill').innerHTML = cur ? badge(lvl[0], lvl[1]) : offBadge(r.err ? 'Server error' : 'Updating…');
      $('k-msg').textContent = cur ? r.total.toLocaleString('en-US') + ' landings in ' + r.seconds + ' s' : r.err || 'Simulating…';
      $('k-p').textContent = pc + '%'; $('k-p-s').textContent = r.total.toLocaleString('en-US') + ' simulated landings inside the dashed circle. 95% interval ' + ciTxt(r.lo, r.hi) + '.';
      const mid = (r.n * r.n - 1) / 2, d = r.slope[mid] > S.sig.slope ? 0 : r.det[mid]; $('k-det').innerHTML = stBadge(d); $('k-det-s').textContent = 'Nothing varied · slope at the aim point ' + r.slope[mid].toFixed(0) + '°';
      const better = r.best.clear;
      // The verdict further up is for one touchdown point and one landing hour. When that passes but many of the scattered
      // landings do not, say so in words, with the most common cause.
      if (d === 2 && r.p < 0.9) {
        let top = 0; r.causes.forEach((v, j) => { if (v > r.causes[top]) top = j; });
        $('k-say').textContent = 'A touchdown exactly on the aim point at the planned hour meets the needs, and that is the verdict above. Across the landing circle only ' + pc + '% of the simulated landings do. The most common failure is "' + CAUSES[top].toLowerCase() + '", in ' + Math.round(r.causes[top] * 100) + '% of runs.'
          + (better ? ' Moving the aim ' + fmtDist(r.best.dist) + ' raises the chance to ' + Math.round(r.best.p * 100) + '%.' : '');
      } else $('k-say').textContent = '';
      $('k-best').textContent = better ? Math.round(r.best.p * 100) + '%' : 'Keep this aim'; $('k-go').disabled = !better || !cur; $('k-go').hidden = !better;
      $('k-best-s').textContent = better ? 'Checked on a separate set of draws: 95% interval ' + ciTxt(r.best.lo, r.best.hi) + '. Move the aim ' + fmtDist(r.best.dist) + ' toward ' + r.best.bearing.toFixed(0) + '° ' + compass(r.best.bearing) + ', to ' + fmtLat(r.best.lat) + ' ' + fmtLon(r.best.lon) : 'Nowhere within ' + fmtDist(1.5 * r.Rkm) + ' is clearly better';
      // failure causes, most frequent first, each bar scaled to the share of failed runs
      const fail = 1 - r.p, ord = CAUSES.map((nm, j) => [nm, r.causes[j]]).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
      let hh = '<div class="bt">Why landings fail, share of all runs</div>';
      ord.forEach(([nm, v]) => { hh += '<div class="br"><span>' + nm + '</span><span class="bb"><i style="width:' + Math.min(100, v / Math.max(fail, 1e-9) * 100).toFixed(1) + '%"></i></span><span class="bv">' + Math.round(v * 100) + '%</span></div>'; });
      $('k-causes').innerHTML = fail < 0.005 || !ord.length ? '<div class="bt">No simulated mission failed</div>' : hh;
      let dh = '<div class="bt">What would help most: points gained if this were known exactly</div>';
      r.drivers.forEach(([nm, v]) => { const gain = Math.round((v - r.p) * 100); dh += '<div class="br"><span>' + nm + '</span><span class="bb gain"><i style="width:' + Math.max(0, Math.min(100, (v - r.p) * 100)).toFixed(1) + '%"></i></span><span class="bv">' + (gain >= 2 ? '+' + gain : '0') + '</span></div>'; });
      $('k-drivers').innerHTML = dh;
      $('k-cap').textContent = 'Landing ' + fmtDT(r.landing) + '. The map is ' + fmtDist(2 * r.E) + ' across, in ' + fmtDist(r.sp) + ' cells, with the Moon\'s near side toward the top. Each cell is coloured by the share of simulated missions that succeed when the lander touches down there. Tap any point on it to aim there.';
    } else { $('k-pill').innerHTML = offBadge(r && r.err ? 'Server error' : 'Simulating…'); $('k-cap').textContent = ''; $('k-msg').textContent = r && r.err ? r.err : 'Simulating thousands of landings on the server…'; }
    if (!shown(cv)) return; cv.style.height = cv.clientWidth + 'px'; const { g, w } = prep(cv); g.fillStyle = C.sky; g.fillRect(0, 0, w, w);
    if (!r || r.pending || !riskOk()) { g.fillStyle = C.skyMuted; g.font = FONTS(13, 400); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(riskOk() ? 'Simulating…' : 'South-pole sites only', w / 2, w / 2); return; }
    if (!r.bg && TER.ready()) {
      const B = 150, c = document.createElement('canvas'); c.width = c.height = B; const cg = c.getContext('2d'), im = cg.createImageData(B, B), H = new Float32Array(B * B), px = 2 * r.E / B;
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) H[j * B + i] = TER.elevXY(r.x0 + (i + 0.5 - B / 2) * px, r.y0 + (B / 2 - (j + 0.5)) * px);
      for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const i1 = Math.min(B - 1, i + 1), i0 = Math.max(0, i - 1), j1 = Math.min(B - 1, j + 1), j0 = Math.max(0, j - 1); const sh = Math.max(0, Math.min(1, 0.5 - 1.3 * ((H[j * B + i1] - H[j * B + i0]) + (H[j1 * B + i] - H[j0 * B + i])) / ((i1 - i0) * px * 1000))); const o = (j * B + i) * 4, v = 20 + 120 * sh; im.data[o] = v; im.data[o + 1] = v + 2; im.data[o + 2] = v + 10; im.data[o + 3] = 255; }
      cg.putImageData(im, 0, 0); r.bg = c;
    }
    if (r.bg) { g.imageSmoothingEnabled = true; g.drawImage(r.bg, 0, 0, w, w); }
    const cwd = w / r.n;
    for (let iy = 0; iy < r.n; iy++) for (let ix = 0; ix < r.n; ix++) { const p = r.P[iy * r.n + ix]; g.fillStyle = seqOf(Math.max(0, p)); g.globalAlpha = cur ? 0.82 : 0.35; g.fillRect(ix * cwd, iy * cwd, cwd + 0.5, cwd + 0.5); }
    g.globalAlpha = 1; g.strokeStyle = C.bad; g.lineWidth = 1.2;
    for (let iy = 0; iy < r.n; iy++) for (let ix = 0; ix < r.n; ix++) if (r.slope[iy * r.n + ix] > S.sig.slope) { const x = ix * cwd, y = iy * cwd; g.beginPath(); g.moveTo(x + 2, y + cwd - 2); g.lineTo(x + cwd - 2, y + 2); g.stroke(); }
    // where the lander may come down, the aim point, the better aim point, a scale bar
    g.strokeStyle = C.skyInk; g.lineWidth = 1.5; g.setLineDash([6, 5]); g.beginPath(); g.arc(w / 2, w / 2, r.Rkm / (2 * r.E) * w, 0, 7); g.stroke(); g.setLineDash([]);
    const cross = (x, y) => { g.lineCap = 'round'; for (const [col, lw] of [[C.sky, 5], [C.skyInk, 2]]) { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(x - 8, y); g.lineTo(x + 8, y); g.moveTo(x, y - 8); g.lineTo(x, y + 8); g.stroke(); } g.lineCap = 'butt'; };
    cross(w / 2, w / 2); skyTag(g, 'Aim point', w / 2, w / 2 + 23, w, { left: true });
    if (r.best.clear) { const bx = (r.best.ix + 0.5) * cwd, by = (r.best.iy + 0.5) * cwd; g.beginPath(); g.moveTo(bx, by - 9); g.lineTo(bx + 9, by); g.lineTo(bx, by + 9); g.lineTo(bx - 9, by); g.closePath(); g.fillStyle = C.skyInk; g.fill(); g.strokeStyle = C.sky; g.lineWidth = 2; g.stroke(); skyTag(g, 'Better aim: ' + Math.round(r.best.p * 100) + '%', bx, by, w, { left: bx > w * 0.6 }); }
    const Ls = [0.1, 0.2, 0.5, 1, 2, 5, 10].reduce((a, b) => Math.abs(b - r.E / 2.5) < Math.abs(a - r.E / 2.5) ? b : a), lp = Ls / (2 * r.E) * w;
    g.strokeStyle = C.skyInk; g.lineWidth = 2; g.beginPath(); g.moveTo(14, w - 16); g.lineTo(14 + lp, w - 16); g.moveTo(14, w - 20); g.lineTo(14, w - 12); g.moveTo(14 + lp, w - 20); g.lineTo(14 + lp, w - 12); g.stroke();
    g.font = FONT(12); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.lineWidth = 4; g.strokeStyle = C.sky; g.strokeText(fmtDist(Ls), 14, w - 26); g.fillStyle = C.skyInk; g.fillText(fmtDist(Ls), 14, w - 26);
  }
  // ---------- plan: mission rescue (server: /rescue) ----------
  function rows() { return [S.site].concat(S.cmp.filter(id => id !== S.site.id).map(byId).filter(Boolean)).slice(0, 5); }
  function rescueNow() {
    const body = { plan: loc(S.plan.site), plan_time: iso(S.plan.t), sites: S.scope === 'cmp' ? rows().map(loc) : S.scope, slip_days: S.slip, flex_days: S.flex, lander: lander(), mission: missionSpec() };
    const key = 'res|' + JSON.stringify(body), q = latest('rescue', key, sig => getJSON('/rescue', body, sig)); return { r: q.v, err: q.err, stale: !q.fresh };
  }
  function drawRescue() {
    $('r-slipv').textContent = S.slip + (S.slip === 1 ? ' day' : ' days');
    $('r-plan').textContent = 'Plan: ' + S.plan.site.name + ', landing ' + fmtDT(S.plan.t) + ', ' + S.cfg.days + '-day surface mission.';
    const q = rescueNow(), r = q.r;
    if (!r) { $('r-cards').innerHTML = '<div class="card"><div class="s">' + (q.err ? 'The server could not search: ' + q.err : 'Checking each site and landing time…') + '</div></div>'; $('r-tbl').innerHTML = ''; $('r-cap').textContent = ''; return; }
    const why = v => v.state === 2 ? 'Power and Earth contact hold for all ' + S.cfg.days + ' days, with the terrain margin.' : v.state === 1 ? 'Works on the modelled terrain; with the margin ' + v.reasons[0] + '.' : cap1(v.reasons.join(', and ')) + '.';
    const card = (k, t, v) => '<div class="card s' + v.state + '"><div class="k">' + k + '</div><div class="v">' + badge(v.state, STN[v.state]) + fmtDate(t) + '</div><div class="s">' + why(v) + '</div></div>';
    $('r-cards').innerHTML = card('As planned, ' + short(S.plan.site), S.plan.t, r.plan) + card('After a ' + S.slip + '-day slip, same site', S.plan.t + S.slip * DAY, r.after_slip);
    let h = '<thead><tr><th>#</th><th>Site</th><th>Land on</th><th>Extra wait</th><th>Verdict</th><th>Lowest battery</th><th>Longest link gap</th><th>Good landing days</th><th>Why</th></tr></thead><tbody>';
    r.alternatives.slice(0, 8).forEach((a, k) => {
      const t = a.landing_time ? Date.parse(a.landing_time) : null, wait = a.extra_wait_days, nm = a.location.id ? short(byId(a.location.id) || a.location) : a.location.name;
      h += '<tr><td>' + (k + 1) + '</td><td><button type="button" data-open="' + (a.location.id || '') + '" data-lat="' + a.location.lat + '" data-lon="' + a.location.lon + '" data-t="' + (t || S.plan.t) + '">' + nm + '</button></td><td>' + (a.state ? fmtDT(t).replace(' UTC', '') : '—') + '</td><td>' + (a.state ? (wait === 0 ? 'none' : '+' + (wait % 1 ? wait.toFixed(2) : wait) + ' d') : '—') + '</td><td>' + stBadge(a.state) + '</td><td>' + Math.round(a.nominal.min_soc * 100) + '%</td><td>' + fmtH(a.nominal.longest_link_gap_h) + '</td><td>' + a.good_landing_days + ' of ' + (S.flex + 1) + '</td><td>' + why(a) + '</td></tr>';
    });
    $('r-tbl').innerHTML = h + '</tbody>';
    const ok = r.alternatives.filter(a => a.state === 2).length, mg = r.alternatives.filter(a => a.state === 1).length;
    $('r-cap').textContent = 'Searched ' + r.alternatives.length + ' sites for landings between ' + fmtDate(S.plan.t + S.slip * DAY) + ' and ' + fmtDate(S.plan.t + (S.slip + S.flex) * DAY) + ', every 6 hours: ' + ok + ' meet the needs with the terrain margin, ' + mg + ' only without it. Ranked by verdict, then shortest extra wait, then battery margin. Select a site name to load that option.';
  }

  // ---------- explore: status ----------
  // A 24-hour sparkline of clearance above the terrain into an <svg viewBox="0 0 200 30">: the dashed line is the terrain
  function spark(id, arr, se, col) {
    const el = $(id); if (!el) return;
    if (!se) { el.innerHTML = ''; return; }
    const x0 = (S.t - TAB.t0) / HOUR, pts = [];
    for (let k = 0; k <= 24; k++) { const x = x0 + k, i = Math.floor(x), f = x - i; if (i < 0 || i + 1 >= se.n) break; pts.push(arr[i] * (1 - f) + arr[i + 1] * f); }
    if (pts.length < 2) { el.innerHTML = ''; return; }
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), sp = Math.max(1e-6, hi - lo), Y = v => (3 + (hi - v) / sp * 24).toFixed(1), X = k => (k / 24 * 200).toFixed(1);
    el.innerHTML = '<line x1="0" x2="200" y1="' + Y(0) + '" y2="' + Y(0) + '" stroke="var(--line-2)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>'
      + '<polyline points="' + pts.map((v, k) => X(k) + ',' + Y(v)).join(' ') + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
      + '<circle cx="1.5" cy="' + Y(pts[0]) + '" r="3" fill="' + col + '"/>';
  }
  const stateLine = (ok, yes, no) => '<span class="state ' + (ok ? 'go' : 'bad') + '">' + ICON[ok ? 2 : 0] + (ok ? yes : no) + '</span>';
  function drawStatus() {
    const c = S.cur, lit = c.sunClr > 0, link = c.earthClr > 0;
    const pills = [];
    pills.push(lit ? ['sun', 2, c.sunFrac < 0.999 ? 'Sun partly visible' : 'Sunlit'] : (c.sunFrac > 0 ? ['warn', 1, 'Sun mostly hidden'] : ['off', 0, 'Dark']));
    pills.push(link ? ['earth', 2, 'Earth line of sight'] : ['off', 0, 'No Earth line of sight']);
    pills.push(lit && link ? ['go', 2, 'Sun and Earth both visible'] : lit ? ['warn', 1, 'Sun only'] : link ? ['warn', 1, 'Earth only'] : ['off', 0, 'Neither visible']);
    $('pills').innerHTML = pills.map(p => '<span class="pill ' + p[0] + '">' + ICON[p[1]] + p[2] + '</span>').join('');
    const se = S.ev && S.ev.sun, ee = S.ev && S.ev.earth, look = 90;
    const sunTxt = lit ? 'The Sun is ' + Math.abs(c.sunClr).toFixed(2) + '° above the terrain to the ' + compass(c.sunAz) + ', with ' + Math.round(c.sunFrac * 100) + '% of its disc showing.'
      : 'The Sun is ' + Math.abs(c.sunClr).toFixed(2) + '° below the terrain horizon' + (c.sunFrac > 0 ? ', with ' + Math.round(c.sunFrac * 100) + '% of its disc still showing.' : '.');
    const earthTxt = link ? 'Earth is ' + Math.abs(c.earthClr).toFixed(2) + '° clear of the terrain.' : (c.earthEl < -c.earthRad ? 'Earth is below the horizon.' : 'Earth is hidden behind terrain.');
    $('say').textContent = sunTxt + ' ' + earthTxt;
    // at a glance: signed clearance in mono, a state line with a tick or cross, and the next 24 hours as a sparkline
    const ser0 = ser(S.site);
    $('t-sun').textContent = sg(c.sunClr, 2).replace('+', ''); $('t-sun-st').innerHTML = stateLine(lit, c.sunFrac < 0.999 ? 'Partly in sunlight' : 'In sunlight', c.sunFrac > 0 ? 'Mostly behind terrain' : 'Behind terrain');
    $('t-earth').textContent = sg(c.earthClr, 2).replace('+', ''); $('t-earth-st').innerHTML = stateLine(link, 'In view', c.earthEl < -c.earthRad ? 'Below the horizon' : 'Behind terrain');
    spark('t-sun-sp', ser0 && ser0.sunClr, ser0, 'var(--sun)'); spark('t-earth-sp', ser0 && ser0.earthClr, ser0, 'var(--earth)');
    $('t-sun-s').textContent = 'Next 24 h. Dashed line is the terrain.'; $('t-earth-s').textContent = 'Next 24 h. Dashed line is the terrain.';
    $('t-sset-k').textContent = lit ? 'Sunset in' : 'Sunrise in'; $('t-sset-x').textContent = lit ? 'After sunset: battery only.' : 'Until then: battery only.';
    $('t-sset').textContent = !S.ev ? '…' : se ? fmtDur(se.t - S.t) : '> ' + look + ' d'; $('t-sset-s').textContent = !S.ev ? '' : se ? fmtDT(se.t) : (lit ? 'No sunset in the next ' + look + ' days' : 'No sunrise in the next ' + look + ' days');
    $('t-eset-k').textContent = link ? 'Earthset in' : 'Earthrise in'; $('t-eset-x').textContent = link ? 'After Earthset: no direct contact.' : 'Until then: no direct contact.';
    $('t-eset').textContent = !S.ev ? '…' : ee ? fmtDur(ee.t - S.t) : (link ? 'Never sets' : 'Never rises'); $('t-eset-s').textContent = !S.ev ? '' : ee ? fmtDT(ee.t) : 'Within the next ' + look + ' days';
    const flat = c.sunFrac * Math.max(0, Math.sin(c.sunEl * D2R)), w = S.cfg.peakW * c.irr * c.sunFrac * arrayShape(S.cfg, c.sunEl, c.sunAz), wp = S.cfg.peakW > 0 ? Math.max(0, Math.min(100, w / S.cfg.peakW * 100)) : 0;
    $('g-power').textContent = Math.round(w) + ' W'; $('g-power-m').style.width = wp.toFixed(1) + '%';
    $('g-power-s').innerHTML = '<span class="num">' + Math.round(wp) + '%</span> of the ' + ARRN[S.cfg.arrayType] + ' array\'s ' + S.cfg.peakW + ' W peak';
    const dsnUp = (S.dsn || []).filter(d => d.in_view !== undefined ? d.in_view : d.elevation_deg > 10);
    const ct = contactNext24(S.site);
    $('g-link').textContent = ct ? fmtH(ct.hours) : '…'; $('g-link-m').style.width = ct ? ct.pct.toFixed(1) + '%' : '0';
    $('g-link-s').innerHTML = (ct ? '<span class="num">' + Math.round(ct.pct) + '%</span> of the day, Earth in view' + (S.cfg.useDsn ? ' and a DSN dish up' : '') + '. ' : '')
      + 'Now: ' + (!link ? (c.earthEl < -c.earthRad ? 'Earth below the horizon' : 'Earth behind the hills') : !S.dsn ? 'Earth in view' : dsnUp.length ? 'via ' + dsnUp.map(d => d.name).join(', ') : 'no DSN dish can see the Moon') + '.';
    $('kv-power').textContent = 'Sun-tracking array ' + Math.round(c.sunFrac * 100) + '%, flat array ' + Math.round(flat * 100) + '% of full output. Your ' + ARRN[S.cfg.arrayType] + ' array would give about ' + Math.round(w) + ' W.';
    $('kv-los').textContent = link ? 'Yes, Earth\'s centre clears the terrain by ' + c.earthClr.toFixed(2) + '°.' : 'No.';
    if (!S.dsn) $('kv-dsn').textContent = 'Checking the Deep Space Network…';
    else {
      const best = S.dsn.slice().sort((a, b) => b.elevation_deg - a.elevation_deg)[0];
      $('kv-dsn').innerHTML = '<table class="dsn">' + S.dsn.map(d => {
        const up = d.in_view !== undefined ? d.in_view : d.elevation_deg > 10, big = (d.antennas || []).find(a => a.diameter_m >= 70);
        return '<tr><td>' + d.name + (d.where ? '<div class="ant">' + d.where + '</div>' : '') + '</td><td class="' + (up ? 'up' : 'down') + '">Moon ' + sg(d.elevation_deg, 0) + (up ? ', in view' : ', too low') + '</td><td class="ant">'
          + (d.antennas ? d.antennas.length + ' dishes' + (big ? ' incl. ' + big.id + ' (70 m)' : '') : '') + '</td></tr>';
      }).join('') + '</table>' + (link && dsnUp.length ? 'Earth is in view, so ' + best.name + ' could talk to the lander now.' : link ? 'Earth is in view but no complex has the Moon above 10°.' : 'Earth is hidden from the lander, so no station can reach it.');
    }
  }
  // Share of the next 24 hours with Earth in view and a DSN complex above its limit (server series: earthClr, dsnEl)
  function contactNext24(site) {
    const se = ser(site); if (!se) return null;
    const i0 = Math.max(0, Math.ceil((S.t - TAB.t0) / HOUR)); let k = 0, n = 0;
    for (let i = i0; i < i0 + 24 && i < se.n; i++) { n++; if (se.earthClr[i] > 0 && (!se.dsnEl || !S.cfg.useDsn || se.dsnEl[i] > 10)) k++; }
    return n ? { pct: 100 * k / n, hours: k } : null;
  }
  function drawSiteInfo() {
    const m = siteMask(S.site);
    $('siteinfo').textContent = S.site.name + ' · ' + fmtLat(S.site.lat) + ', ' + fmtLon(S.site.lon) + (m ? ' · terrain height ' + (m.h0 >= 0 ? '+' : '−') + Math.abs(Math.round(m.h0)).toLocaleString('en-US') + ' m · ' + tierText(m) + ', from ' + sg(m.lo, 1) + ' to ' + sg(m.hi, 1) + '. ' : ' · loading the horizon… ') + (S.site.note || '');
  }

  // ---------- explore: sky panorama ----------
  function skyRange(site) {
    const se = ser(site), m = siteMask(site); if (!se) return { yMin: -4, yMax: 10 };
    let hi = m.hi; const a0 = idx(S.anchor), nW = S.span * 24;
    for (let i = a0; i < a0 + nW && i < se.n; i += 2) { if (se.sunEl[i] > hi) hi = se.sunEl[i]; if (se.earthEl[i] > hi) hi = se.earthEl[i]; }
    const yMax = hi < 9 ? 10 : hi < 27 ? 30 : 90;
    return { yMin: Math.min(yMax === 90 ? -12 : yMax === 30 ? -6 : -4, Math.floor(m.lo) - 1), yMax };
  }
  const COMPASS_WORD = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };
  // The horizon panorama. Always a night scene: the --sky colours in both themes. Paths are solid where the body clears
  // the terrain and dotted, half strength, where the hills hide it; each body carries a tag with its clearance.
  function paintSky(g, w, h, site, c, range) {
    const mini = w < 520 || h < 230, padL = mini ? 40 : 52, padR = 14, padT = 16, padB = mini ? 26 : 34, pw = w - padL - padR, ph = h - padT - padB;
    const se = ser(site), mm = siteMask(site);
    g.fillStyle = C.sky; g.fillRect(0, 0, w, h);
    if (!se || !c) { g.fillStyle = C.skyMuted; g.font = FONTS(13, 400); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('Loading the horizon…', w / 2, h / 2); return; }
    const { yMin, yMax } = range || skyRange(site), m = mm.mask;
    const X = az => padL + az / 360 * pw, Y = el => padT + (yMax - el) / (yMax - yMin) * ph;
    g.font = FONT(12); g.textBaseline = 'middle'; g.textAlign = 'right';
    const stepY = yMax === 90 ? 15 : yMax === 30 ? 5 : 2;
    for (let e = Math.ceil(yMin / stepY) * stepY; e <= yMax; e += stepY) {
      if (Y(e) < padT - 1) continue;
      g.strokeStyle = C.skyMuted; g.globalAlpha = e === 0 ? 0.5 : 0.14; g.setLineDash(e === 0 ? [4, 4] : []); g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, Y(e)); g.lineTo(w - padR, Y(e)); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = C.skyMuted; g.fillText((e > 0 ? '+' : e < 0 ? '−' : '') + Math.abs(e) + '°', padL - 8, Y(e));
    }
    g.setLineDash([]); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const pts = mini ? [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]] : [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315], ['N', 360]];
    pts.forEach(([t, a]) => { g.strokeStyle = C.skyMuted; g.globalAlpha = 0.1; g.beginPath(); g.moveTo(X(a), padT); g.lineTo(X(a), padT + ph); g.stroke(); g.globalAlpha = 1; g.fillStyle = t.length === 1 ? C.skyInk : C.skyMuted; g.fillText(t, Math.max(padL + 6, Math.min(w - padR - 6, X(a))), h - (mini ? 8 : 12)); });
    g.save(); g.beginPath(); g.rect(padL, padT, pw, ph); g.clip();
    const M = a => maskAt(m, a);
    // terrain: a solid fill with a bright crest, so the horizon is the strongest edge in the picture
    g.fillStyle = C.terrain; g.beginPath(); g.moveTo(X(0), padT + ph + 2); for (let a = 0; a <= 360; a += 0.5) g.lineTo(X(a), Y(M(a))); g.lineTo(X(360), padT + ph + 2); g.closePath(); g.fill();
    g.strokeStyle = C.crest; g.lineWidth = 1.5; g.lineJoin = 'round'; g.beginPath(); for (let a = 0; a <= 360; a += 0.5) { const x = X(a), y = Y(M(a)); a ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    if (!mini && Y(0) > padT + 10 && Y(0) < padT + ph - 4) { g.font = FONT(12); g.fillStyle = C.skyMuted; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText('level horizon', padL + 6, Y(0) - 4); }
    const x0 = (S.t - TAB.t0) / HOUR, nT = Math.round(SYNODIC * 24);
    const i0 = Math.max(0, Math.ceil(x0)), i1 = Math.min(se.n - 1, i0 + nT);
    function track(az, el, clr, col) {
      g.lineCap = 'round';
      for (const vis of [false, true]) {
        g.strokeStyle = col; g.globalAlpha = vis ? 1 : 0.5; g.lineWidth = vis ? 2 : 1.5; g.setLineDash(vis ? [] : [2, 5]); g.beginPath();
        let pen = false;
        for (let i = i0; i <= i1; i++) {
          const ok = (clr[i] > 0) === vis && (i === i0 || Math.abs(az[i] - az[i - 1]) < 180);
          if (!ok) { pen = false; continue; }
          if (!pen) { if (i > i0 && Math.abs(az[i] - az[i - 1]) < 180) g.moveTo(X(az[i - 1]), Y(el[i - 1])); else g.moveTo(X(az[i]), Y(el[i])); pen = true; }
          g.lineTo(X(az[i]), Y(el[i]));
        }
        g.stroke();
      }
      g.setLineDash([]); g.globalAlpha = 1; g.lineCap = 'butt';
      // ringed day markers, labelled every 7 days
      g.font = FONT(12); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      for (let d = 7, i = i0 + 7 * 24; i <= i1 && d < 28; i += 7 * 24, d += 7) {
        const x = X(az[i]), y = Y(el[i]); g.beginPath(); g.arc(x, y, 3, 0, 7); g.fillStyle = C.sky; g.fill(); g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
        if (!mini) { g.fillStyle = col; g.fillText('+' + d + ' d', x, y - 10); }
      }
    }
    track(se.earthAz, se.earthEl, se.earthClr, C.skyEarth);
    track(se.sunAz, se.sunEl, se.sunClr, C.skySun);
    const bodies = [];
    function body(az, el, kind, visible) {
      const x = X(az), y = Math.max(padT + 8, Math.min(padT + ph - 8, Y(el))), col = kind === 'sun' ? C.skySun : C.skyEarth;
      g.globalAlpha = visible ? 1 : 0.45;
      if (kind === 'sun') { g.fillStyle = col; g.globalAlpha *= 0.12; g.beginPath(); g.arc(x, y, 20, 0, 7); g.fill(); g.globalAlpha = (visible ? 1 : 0.45) * 0.22; g.beginPath(); g.arc(x, y, 12, 0, 7); g.fill(); g.globalAlpha = visible ? 1 : 0.45; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
      else { g.fillStyle = col; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill(); g.fillStyle = C.sky; g.globalAlpha *= 0.45; g.beginPath(); g.moveTo(x - 8, y); g.arc(x, y, 8, Math.PI, 0, true); g.closePath(); g.fill(); }
      if (!visible) { g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([2, 3]); g.beginPath(); g.arc(x, y, 11, 0, 7); g.stroke(); g.setLineDash([]); }
      g.globalAlpha = 1; bodies.push({ x, y, kind, col });
    }
    body(c.earthAz, c.earthEl, 'earth', c.earthClr > 0);
    body(c.sunAz, c.sunEl, 'sun', c.sunClr > 0);
    g.restore();
    // tags with the name and the clearance, kept inside the frame and apart from each other
    const boxes = [];
    bodies.slice().reverse().forEach(b => {
      const clr = b.kind === 'sun' ? c.sunClr : c.earthClr, name = b.kind === 'sun' ? 'Sun' : 'Earth';
      const val = Math.abs(clr).toFixed(1) + '° ' + (clr > 0 ? 'above' : 'below') + ' terrain';
      g.font = FONT(12); const tw = mini ? labW(g, name, 12) + g.measureText(' ' + Math.abs(clr).toFixed(1) + '°').width + 20 : Math.max(labW(g, name, 12), g.measureText(val).width) + 20, th = mini ? 24 : 40;
      let bx = b.x + 18, by = b.y - th - 10;
      if (bx + tw > w - 4) bx = b.x - 18 - tw; if (bx < 4) bx = 4;
      if (by < 4) by = b.y + 16; if (by + th > h - 4) by = h - th - 4;
      for (const o of boxes) if (bx < o.x + o.w + 6 && bx + tw + 6 > o.x && by < o.y + o.h + 6 && by + th + 6 > o.y) by = o.y + o.h + 6 + th < h - 4 ? o.y + o.h + 6 : Math.max(4, o.y - th - 6);
      boxes.push({ x: bx, y: by, w: tw, h: th });
      g.fillStyle = C.sky; g.globalAlpha = 0.88; rbar(g, bx, by, tw, th, 4); g.globalAlpha = 0.7; g.strokeStyle = b.col; g.lineWidth = 1; g.beginPath(); g.roundRect ? g.roundRect(bx + 0.5, by + 0.5, tw - 1, th - 1, 4) : g.rect(bx, by, tw, th); g.stroke(); g.globalAlpha = 1;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = b.col;
      if (mini) { labTxt(g, name, bx + 10, by + 16, 12); const nw = labW(g, name, 12); g.font = FONT(12); g.fillStyle = C.skyInk; g.fillText(' ' + (clr > 0 ? '' : '−') + Math.abs(clr).toFixed(1) + '°', bx + 10 + nw, by + 16); }
      else { labTxt(g, name, bx + 10, by + 16, 12); g.font = FONT(12); g.fillStyle = C.skyInk; g.fillText(val, bx + 10, by + 32); }
    });
  }
  function drawSky() {
    const cv = $('sky'); if (!shown(cv)) return; const { g, w, h } = prep(cv);
    paintSky(g, w, h, S.site, S.cur);
    const c = S.cur, b = v => '<b>' + Math.abs(v).toFixed(1) + '°</b>';
    const sunW = c.sunClr > 0 ? 'The Sun is ' + b(c.sunClr) + ' clear of the hills to the ' + COMPASS_WORD[compass(c.sunAz)] + '.' : 'The Sun is ' + b(c.sunClr) + ' behind the hills to the ' + COMPASS_WORD[compass(c.sunAz)] + '.';
    const earthW = c.earthClr > 0 ? 'Earth is ' + b(c.earthClr) + ' clear, ' + (c.earthEl < 10 ? 'low in the ' : 'in the ') + COMPASS_WORD[compass(c.earthAz)] + '.' : 'Earth is ' + b(c.earthClr) + ' behind the terrain, to the ' + COMPASS_WORD[compass(c.earthAz)] + '.';
    $('skysay').innerHTML = sunW + ' ' + earthW;
    $('skycap').textContent = Math.abs(S.site.lat) > 80
      ? 'A full turn of the horizon. Height above a level horizon runs up the side. A path is solid where the body clears the terrain and dotted where the hills hide it. Near the poles the Sun never climbs more than a degree or two, so one ridge decides whether a lander has power, and Earth drifts in a small loop as the Moon wobbles.'
      : 'A full turn of the horizon. Height above a level horizon runs up the side. A path is solid where the body clears the terrain and dotted where the hills hide it. Away from the poles the Sun crosses the sky once per lunar day, about two weeks of light then two weeks of night, while Earth stays almost fixed.';
  }
  // ---------- strips shared by timeline and compare ----------
  // a yes/no lane: rounded runs on a rounded track
  function strip(g, pred, i0, i1, x, y, w, h, col) {
    g.fillStyle = col; const n = i1 - i0; let s = -1;
    for (let i = i0; i <= i1; i++) {
      const on = i < i1 && pred(i);
      if (on && s < 0) s = i; if (!on && s >= 0) { const xa = x + (s - i0) / n * w, xb = x + (i - i0) / n * w; rbar(g, xa, y, Math.max(1.5, xb - xa), h, 3); s = -1; }
    }
  }
  const shareOf = (pred, i0, i1) => { let k = 0, n = 0; for (let i = i0; i < i1; i++) { n++; if (pred(i)) k++; } return n ? 100 * k / n : 0; };
  // the ticks along a time axis, for the labels and for the gridlines through the chart
  function timeTicks(t0, span) {
    const ticks = [];
    if (span <= 1) for (let k = 0; k <= 24; k += 3) { const t = t0 + k * HOUR; ticks.push([t, p2(new Date(t).getUTCHours()) + ':00']); }
    else if (span <= 7) for (let d = 0; d <= span; d++) ticks.push([t0 + d * DAY, fmtDM(t0 + d * DAY)]);
    else if (span <= 30) for (let d = 0; d <= span; d += 5) ticks.push([t0 + d * DAY, fmtDM(t0 + d * DAY)]);
    else if (span <= 90) for (let d = 0; d <= span; d += 15) ticks.push([t0 + d * DAY, fmtDM(t0 + d * DAY)]);
    else { const d = new Date(t0); let yy = d.getUTCFullYear(), mm = d.getUTCMonth() + 1; for (let k = 0; k < 13; k++, mm++) { if (mm > 11) { mm = 0; yy++; } const t = Date.UTC(yy, mm, 1); if (t <= t0 + span * DAY) ticks.push([t, MON[mm] + (mm === 0 ? ' ’' + String(yy).slice(2) : '')]); } }
    return ticks;
  }
  function timeAxis(g, x, y, w, t0, span) {
    g.font = FONT(12); g.fillStyle = C.muted; g.textBaseline = 'top'; g.strokeStyle = C.line; g.lineWidth = 1;
    let lastR = -1e9;
    timeTicks(t0, span).forEach(([t, lab]) => {
      const px = x + (t - t0) / (span * DAY) * w; g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + 4); g.stroke();
      const tw = g.measureText(lab).width; let lx = px + 4; lx = Math.max(x, Math.min(x + w - tw, lx));
      if (lx > lastR + 8) { g.textAlign = 'left'; g.fillText(lab, lx, y + 7); lastR = lx + tw; }
    });
  }
  function gridX(g, x, w, t0, span, yTop, yBot) {
    g.strokeStyle = C.line; g.globalAlpha = 0.6; g.lineWidth = 1;
    timeTicks(t0, span).forEach(([t]) => { const px = Math.round(x + (t - t0) / (span * DAY) * w) + 0.5; g.beginPath(); g.moveTo(px, yTop); g.lineTo(px, yBot); g.stroke(); });
    g.globalAlpha = 1;
  }
  // the clock: a 1.5 px line with a date-and-time tag at the top, the same on every time chart
  function clockAt(g, cx, yTop, yBot, x0, x1) {
    g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, yTop + 26); g.lineTo(cx, yBot); g.stroke();
    const d = new Date(S.t), t = fmtDM(S.t) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
    g.font = FONT(12); const tw = g.measureText(t).width + 20, lx = Math.max(x0, Math.min(x1 - tw, cx - tw / 2));
    pillTag(g, t, lx, yTop, C.ink, C.bg);
  }
  // pad is read on every event: the charts set their margins from their width when they draw
  function scrub(cv, pad, setter) {
    let down = false;
    const at = e => { const r = cv.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r))); setter(S.anchor + f * S.span * DAY); };
    cv.addEventListener('pointerdown', e => { down = true; S.scrubbing = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} at(e); });
    cv.addEventListener('pointermove', e => { if (down) at(e); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { if (down) { down = false; S.scrubbing = false; renderSoon(); } }));
  }
  // window statistics (server: /windows)
  function statsFor(site, t0, days) {
    const key = 'win|' + siteKey(site) + '|' + S.eye + '|' + t0 + '|' + days;
    const j = need(key, () => getJSON('/windows?' + qs({ ...loc(site), start: iso(t0), end: iso(t0 + days * DAY), array_height_m: S.eye, antenna_height_m: S.eye })));
    if (!j) return null; const s = j.stats;
    return { litPct: s.sunlit_pct, linkPct: s.earth_in_view_pct, bothPct: s.both_pct, maxLitD: s.longest_sunlit_h / 24, maxDarkD: s.longest_dark_h / 24, maxOutD: s.longest_radio_gap_h / 24, contactPct: s.earth_contact_pct, maxContactD: s.longest_contact_gap_h === null || s.longest_contact_gap_h === undefined ? null : s.longest_contact_gap_h / 24, pTrack: s.power_share_tracking_pct, maxSunEl: s.max_sun_elevation_deg, maxEarthEl: s.max_earth_elevation_deg };
  }

  // ---------- explore: timeline ----------
  const TLP = { l: 150, r: 56 };
  // the longest run of hours where pred holds, inside [i0, i1): its start and end times
  function longestRun(pred, i0, i1) { let best = [0, 0], s = -1; for (let i = i0; i <= i1; i++) { const on = i < i1 && pred(i); if (on && s < 0) s = i; if (!on && s >= 0) { if (i - s > best[1] - best[0]) best = [s, i]; s = -1; } } return best[1] > best[0] ? [TAB.t0 + best[0] * HOUR, TAB.t0 + best[1] * HOUR] : null; }
  const durTxt = ms => ms > 0 ? fmtDur(ms) : '0 h';
  const rangeTxt = r => { if (!r) return 'none in the window'; const a = new Date(r[0]), b = new Date(r[1]); return a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() !== b.getUTCDate() ? a.getUTCDate() + ' to ' + fmtDM(r[1]) : fmtDM(r[0]) + ' to ' + fmtDM(r[1]); };
  function drawTimeline() {
    const cv = $('tl'); if (!shown(cv)) return; const se = ser(S.site); if (!se) { waiting(cv); return; } const { g, w, h } = prep(cv);
    const narrow = w < 600; TLP.l = narrow ? 92 : 150; TLP.r = narrow ? 44 : 56;
    const a0 = idx(S.anchor), nW = Math.min(S.span * 24, se.n - 1 - a0), px = TLP.l, pw = w - TLP.l - TLP.r, top = 34, ln = 14, lg = 10, nl = 5, lanesH = nl * ln + (nl - 1) * lg;
    const ch = h - top - 22 - lanesH - 34, sy = top + ch + 22, yb = sy + lanesH, st = nW > 3000 ? 2 : 1;
    let lim = 1; for (let i = 0; i <= nW; i += st) lim = Math.max(lim, Math.abs(se.sunClr[a0 + i]), Math.abs(se.earthClr[a0 + i]));
    lim = lim <= 4 ? Math.ceil(lim) : lim <= 12 ? Math.ceil(lim / 2) * 2 : lim <= 30 ? 30 : lim <= 60 ? 60 : 90;
    const X = i => px + i / (S.span * 24) * pw, Y = v => top + (lim - Math.max(-lim, Math.min(lim, v))) / (2 * lim) * ch;
    // below the zero line is "behind terrain"; the band just above it is the terrain margin
    g.fillStyle = C.cell; g.globalAlpha = 0.55; g.fillRect(px, Y(0), pw, Y(-lim) - Y(0)); g.globalAlpha = 1;
    if (S.cfg.margin > 0) { g.fillStyle = C.cell; g.globalAlpha = 0.3; g.fillRect(px, Y(S.cfg.margin), pw, Math.max(1, Y(0) - Y(S.cfg.margin))); g.globalAlpha = 1; }
    gridX(g, px, pw, S.anchor, S.span, top, yb);
    g.font = FONT(12); g.textBaseline = 'middle'; g.textAlign = 'right';
    const sv = lim <= 2 ? 1 : lim <= 4 ? 1 : lim / 2;
    for (let v = -lim; v <= lim + 1e-9; v += sv) { g.strokeStyle = v === 0 ? C.line2 : C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(px, Math.round(Y(v)) + 0.5); g.lineTo(px + pw, Math.round(Y(v)) + 0.5); g.stroke(); g.fillStyle = C.muted; g.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '°', px - 8, Y(v)); }
    if (!narrow) { g.fillStyle = C.muted; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; labTxt(g, 'Height above', 0, top + 12, 12); labTxt(g, 'terrain', 0, top + 28, 12); }
    g.font = FONT(12); g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'alphabetic'; if (Y(-lim) - Y(0) > 30) g.fillText('shaded: behind terrain', px + pw - 6, Y(-lim) - 8);
    const curve = (a, col) => {
      g.beginPath(); g.moveTo(X(0), Y(0)); for (let i = 0; i <= nW; i += st) g.lineTo(X(i), Y(Math.max(0, a[a0 + i]))); g.lineTo(X(nW), Y(0)); g.closePath(); g.fillStyle = col; g.globalAlpha = 0.14; g.fill(); g.globalAlpha = 1;
      g.beginPath(); for (let i = 0; i <= nW; i += st) { i ? g.lineTo(X(i), Y(a[a0 + i])) : g.moveTo(X(i), Y(a[a0 + i])); } g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    };
    curve(se.earthClr, C.earth); curve(se.sunClr, C.sun);
    // name each curve at its right end, kept apart
    const ye = Y(se.earthClr[a0 + nW]), ys = Y(se.sunClr[a0 + nW]); let yE = ye + 4, yS = ys + 4; if (Math.abs(yE - yS) < 16) { if (yE < yS) yE = yS - 16; else yS = yE - 16; }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = C.earth; labTxt(g, narrow ? 'E' : 'Earth', px + pw + 8, yE, 12); g.fillStyle = C.sun; labTxt(g, 'Sun', px + pw + 8, yS, 12);
    // the yes/no lanes, named in full, each ending in its share of the window
    const dsnOk = i => !se.dsnEl || se.dsnEl[i] > 10, i1 = a0 + nW;
    const lanes = [[narrow ? 'Sun' : 'Sun up', C.sun, i => se.sunClr[i] > 0], [narrow ? 'Earth' : 'Earth in view', C.earth, i => se.earthClr[i] > 0], [narrow ? 'DSN' : 'DSN dish up', C.muted, dsnOk],
                   ['Contact', C.earth, i => se.earthClr[i] > 0 && dsnOk(i)], [narrow ? 'Pwr + cont.' : 'Power + contact', C.go, i => se.sunClr[i] > 0 && se.earthClr[i] > 0 && dsnOk(i)]];
    lanes.forEach(([t, col, pred], k) => {
      const y = sy + k * (ln + lg); g.fillStyle = C.cell; rbar(g, px, y, pw, ln, 3); strip(g, pred, a0, i1, px, y, X(nW) - px, ln, col);
      g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'middle'; labTxt(g, t, px - 8, y + ln / 2 + 1, 12);
      g.font = FONT(12); g.fillStyle = C.ink; g.textAlign = 'left'; g.fillText(Math.round(shareOf(pred, a0, i1)) + '%', px + pw + 8, y + ln / 2 + 1);
    });
    timeAxis(g, px, yb + 6, pw, S.anchor, S.span);
    // the clock, with a dot on each curve
    const cx = px + (S.t - S.anchor) / (S.span * DAY) * pw;
    if (cx >= px - 1 && cx <= px + pw + 1) {
      clockAt(g, cx, 2, yb, px - 40, px + pw + TLP.r);
      const c = stateAt(se, S.t); if (c) for (const [v, col] of [[c.earthClr, C.earth], [c.sunClr, C.sun]]) { g.beginPath(); g.arc(cx, Y(v), 4.5, 0, 7); g.fillStyle = col; g.fill(); g.strokeStyle = C.panel; g.lineWidth = 2; g.stroke(); }
    }
    // four stat blocks above the chart, each with its dates
    const s = statsFor(S.site, S.anchor, S.span), win = S.span <= 1 ? 'of the 24 hours' : 'of the ' + S.span + ' days';
    const blk = (k, v, sub) => '<div class="stat"><span class="lab">' + k + '</span><b>' + v + '</b><span class="cap">' + sub + '</span></div>';
    $('tlstats').innerHTML = !s ? blk('Sun up', '…', win) + blk('Earth in view', '…', win) + blk('Longest night', '…', '') + blk('Longest Earth gap', '…', '')
      : blk('Sun up', s.litPct.toFixed(0) + '%', win) + blk('Earth in view', s.linkPct.toFixed(0) + '%', win + (s.contactPct !== null && s.contactPct !== undefined ? ' · contact ' + s.contactPct.toFixed(0) + '%' : ''))
        + blk('Longest night', durTxt(s.maxDarkD * DAY), rangeTxt(longestRun(i => !(se.sunClr[i] > 0), a0, i1))) + blk('Longest Earth gap', durTxt(s.maxOutD * DAY), rangeTxt(longestRun(i => !(se.earthClr[i] > 0), a0, i1)));
  }
  // ---------- compare: the same instant at every site ----------
  function drawCmpSky() { const rs = rows(), rg = rs.map(skyRange); skyCells($('cmpsky'), rs, 210, null, { yMin: Math.min(...rg.map(r => r.yMin)), yMax: Math.max(...rg.map(r => r.yMax)) }); }
  // a verdict badge drawn on a canvas: outline, icon and word; marginal is hatched
  function canvasBadge(g, x, y, st, text, cols, ground) {
    g.font = FONTS(13); const tw = g.measureText(text).width, bw = tw + 38, bh = 26, col = cols[st];
    g.fillStyle = ground; rbar(g, x, y, bw, bh, 4);
    if (st === 1) { g.save(); g.beginPath(); g.rect(x, y, bw, bh); g.clip(); g.strokeStyle = col; g.globalAlpha = 0.16; g.lineWidth = 2; for (let k = -bh; k < bw; k += 7) { g.beginPath(); g.moveTo(x + k, y + bh); g.lineTo(x + k + bh, y); g.stroke(); } g.restore(); g.globalAlpha = 1; }
    g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.roundRect ? g.roundRect(x + 0.5, y + 0.5, bw - 1, bh - 1, 4) : g.rect(x, y, bw, bh); g.stroke();
    const ix = x + 10, iy = y + 6; g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath();
    if (st === 2) { g.moveTo(ix + 2.6, iy + 7.4); g.lineTo(ix + 5.4, iy + 10.2); g.lineTo(ix + 11.4, iy + 4.2); g.stroke(); }
    else if (st === 1) { g.moveTo(ix + 7, iy + 2.2); g.lineTo(ix + 7, iy + 8.3); g.stroke(); g.beginPath(); g.arc(ix + 7, iy + 11.4, 1.2, 0, 7); g.fill(); }
    else { g.moveTo(ix + 3.5, iy + 3.5); g.lineTo(ix + 10.5, iy + 10.5); g.moveTo(ix + 10.5, iy + 3.5); g.lineTo(ix + 3.5, iy + 10.5); g.stroke(); }
    g.lineCap = 'butt'; g.fillStyle = col; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(text, x + 28, y + bh / 2 + 0.5);
    return bw;
  }
  function skyCells(cv, rs, ch, names, range) {
    if (!shown(cv)) return;
    const cw0 = cv.clientWidth, cols = Math.min(rs.length, cw0 >= 1100 ? 3 : cw0 >= 760 ? 2 : 1), gap = 8, hh = 40, nr = Math.ceil(rs.length / cols);
    cv.style.height = (nr * (ch + hh) + (nr - 1) * gap) + 'px';
    const { g, w } = prep(cv), cw = (w - (cols - 1) * gap) / cols, SV = [C.skyBad, C.skyWarn, C.skyGo];
    rs.forEach((s, k) => {
      const x = (k % cols) * (cw + gap), y = Math.floor(k / cols) * (ch + hh + gap), c = s === S.site ? S.cur : stateAt(ser(s), S.t);
      g.save(); g.translate(x, y); g.beginPath(); g.roundRect ? g.roundRect(0, 0, cw, ch + hh, 4) : g.rect(0, 0, cw, ch + hh); g.clip();
      g.fillStyle = C.sky; g.fillRect(0, 0, cw, hh);
      // the header row: the site's name, then its state as a badge
      const nm = names ? names[k] : short(s); g.font = FONTS(14); g.fillStyle = C.skyInk; g.textAlign = 'left'; g.textBaseline = 'middle';
      const nw = Math.min(g.measureText(nm).width, cw - 24); g.fillText(nm, 12, hh / 2 + 2, cw - 24);
      if (c) {
        const lit = c.sunClr > 0, link = c.earthClr > 0, st = lit && link ? [2, 'Power and Earth link'] : lit ? [1, 'Power, no Earth link'] : link ? [1, 'Earth link, no power'] : [0, 'No power, no Earth link'];
        g.font = FONTS(13); const bw = g.measureText(st[1]).width + 38, sh = ['None', 'Partial', 'Both'][st[0]], sw = g.measureText(sh).width + 38;
        if (12 + nw + 12 + bw <= cw - 8) canvasBadge(g, cw - bw - 8, 7, st[0], st[1], SV, C.sky); else if (12 + nw + 12 + sw <= cw - 8) canvasBadge(g, cw - sw - 8, 7, st[0], sh, SV, C.sky);
      }
      g.translate(0, hh); paintSky(g, cw, ch, s, c, range);
      g.restore();
    });
  }
  // ---------- learn: why the south pole is hard ----------
  function drawLearn() {
    const eq = byId('a11'), po = byId('shack');
    $('l-when').textContent = fmtDT(S.t); $('l-play').textContent = S.playing ? 'Pause' : 'Play a lunar month';
    skyCells($('learnsky'), [eq, po], 240, ['Apollo 11 · near the equator', 'Shackleton rim · 7 km from the south pole']);
    const a = statsFor(eq, TAB.t0, 365), b = statsFor(po, TAB.t0, 365);
    if (a && b) {
      const tile = (k, va, vb, note) => '<div class="tile"><div class="k">' + k + '</div><div class="duo"><div><span>Apollo 11</span><b>' + va + '</b></div><div><span>Shackleton rim</span><b>' + vb + '</b></div></div><div class="s">' + note + '</div></div>';
      $('l-tiles').innerHTML = tile('Highest the Sun climbs', a.maxSunEl.toFixed(0) + '°', b.maxSunEl.toFixed(1) + '°', 'With the Sun this low, a hill several kilometres away can put the site in shadow.')
        + tile('Longest night', a.maxDarkD.toFixed(1) + ' d', b.maxDarkD.toFixed(1) + ' d', 'Rims and ridges near the pole get short nights. Some crater floors nearby never get sunlight at all.')
        + tile('Time with Earth in view', a.linkPct.toFixed(0) + '%', b.linkPct.toFixed(0) + '%', 'On the near side Earth never sets. At the pole, libration lifts it above the terrain and drops it behind again roughly every 27 days.');
      $('l-facts').textContent = 'Figures cover the 365 days from ' + fmtDate(TAB.t0) + ', measured against the real terrain at each site.';
    }
    const cv = $('tilt'); if (!shown(cv)) return; const { g, w, h } = prep(cv), two = w >= 620, pw = two ? w / 2 : w, ph = two ? h : h / 2;
    [['Earth', 23.44, C.earth, C.cell, 'At midsummer the Sun stands 23.4° above the horizon at the pole.'], ['Moon', 1.54, C.crest, C.cell, 'The Sun never rises more than about 1.5° above a level horizon at the pole.']].forEach(([name, tilt, lit, dark, note], k) => {
      const ox = two ? k * pw : 0, oy = two ? 0 : k * ph, cx = ox + pw * 0.56, cy = oy + ph * 0.46, r = Math.min(pw * 0.2, ph * 0.3), a = tilt * D2R;
      g.strokeStyle = C.sun; g.fillStyle = C.sun; g.lineWidth = 1.5; g.globalAlpha = 0.7;
      for (let i = -2; i <= 2; i++) { const y = cy + i * r * 0.5, x0 = ox + 16, x1 = cx - r - 26; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.beginPath(); g.moveTo(x1 + 7, y); g.lineTo(x1, y - 4); g.lineTo(x1, y + 4); g.closePath(); g.fill(); }
      g.globalAlpha = 1; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; labTxt(g, 'Sunlight', ox + 16, cy - r * 1.0 - 12, 12);
      g.fillStyle = dark; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.fillStyle = lit; g.beginPath(); g.arc(cx, cy, r, Math.PI / 2, 3 * Math.PI / 2); g.closePath(); g.fill();
      const sx = -Math.sin(a), sy = Math.cos(a);
      g.strokeStyle = C.muted; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx, cy - r * 1.3); g.lineTo(cx, cy + r * 1.3); g.stroke(); g.setLineDash([]);
      g.strokeStyle = C.ink; g.lineWidth = 1.8; g.beginPath(); g.moveTo(cx - sx * r * 1.3, cy - sy * r * 1.3); g.lineTo(cx + sx * r * 1.3, cy + sy * r * 1.3); g.stroke();
      const px = cx + sx * r, py = cy + sy * r; g.strokeStyle = C.muted; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px - sy * 34, py + sx * 34); g.lineTo(px + sy * 34, py - sx * 34); g.stroke();
      g.fillStyle = C.bad; g.beginPath(); g.arc(px, py, 4.5, 0, 7); g.fill();
      g.fillStyle = C.ink; g.font = '600 16px "Space Grotesk", "IBM Plex Sans", system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(name + ', axis tilted ' + tilt.toFixed(1) + '°', ox + pw / 2, oy + 20);
      g.fillStyle = C.bad; g.textAlign = 'right'; labTxt(g, 'South pole', px - 12, py + 18, 12);
      g.font = FONTS(13, 400); g.fillStyle = C.muted; g.textAlign = 'center'; g.fillText(note, ox + pw / 2, oy + ph - 10, pw - 20);
    });
  }
  // ---------- compare ----------
  function calNow() {
    const rs = rows(), body = { locations: rs.map(loc), start: iso(S.calAnchor), days: 366, lander: lander(), mission: missionSpec() }, key = 'cal|' + JSON.stringify(body);
    const q = latest('calendar', key, sig => getJSON('/calendar', body, sig)), j = q.v; if (!j) return null;
    const out = {}; j.sites.forEach((s, k) => { out[siteKey(rs[k])] = s; }); return out;
  }
  const CMPP = { l: 150, r: 56 };
  function drawCompare() {
    const cv = $('cmp'); if (!shown(cv)) return;
    const rs = rows(), a0 = idx(S.anchor), nW = S.span * 24;
    $('chips').innerHTML = rs.map((s, i) => '<span class="chip' + (i === 0 ? ' pin' : '') + '">' + s.name + (i === 0 ? '' : '<button type="button" data-rm="' + s.id + '" aria-label="Remove ' + s.name + '">×</button>') + '</span>').join('');
    const st = rs.map(s => statsFor(s, S.anchor, S.span)), cal = calNow();
    // percentage columns get a small bar in the cell; the best value in each column gets a tick as well as bold
    const pct = v => v === null || v === undefined ? '—' : v.toFixed(0) + '%';
    const cols = [['Sunlit', 'litPct', 1, pct, true], ['Earth in view', 'linkPct', 1, pct, true], ['Both', 'bothPct', 1, pct, true],
      ['Longest sunlit run', 'maxLitD', 1, v => v.toFixed(1) + ' d'], ['Longest night', 'maxDarkD', -1, v => v.toFixed(1) + ' d'], ['Longest Earth gap', 'maxOutD', -1, v => v.toFixed(1) + ' d'], ['Contact with DSN', 'contactPct', 1, pct, true], ['Mean solar availability', 'pTrack', 1, pct, true]];
    const cell = (v, txt, best, bar) => '<td' + (best ? ' class="best"' : '') + '>' + (best ? ICON[2] + ' ' : '') + txt + (bar && v !== null && v !== undefined ? '<span class="cb"><i style="width:' + Math.max(0, Math.min(100, v)).toFixed(0) + '%"></i></span>' : '') + '</td>';
    let html = '<thead><tr><th>Site</th>' + cols.map(c => '<th>' + c[0] + '</th>').join('') + '<th>Good landing days, next 12 months</th><th>Terrain</th></tr></thead><tbody>';
    // the best value in a column, only when the sites differ
    const bestOf = vals => { const ok = vals.filter(v => v > -1e9); return ok.length > 1 && Math.max(...ok) !== Math.min(...ok) ? Math.max(...ok) : null; };
    const good = rs.map(s => cal && cal[siteKey(s)] ? cal[siteKey(s)].good_days : null);
    rs.forEach((s, i) => {
      const m = siteMask(s);
      html += '<tr><td>' + s.name + '</td>' + cols.map(c => { if (!st[i]) return '<td>…</td>'; const vals = st.map(x => x && x[c[1]] !== null && x[c[1]] !== undefined ? x[c[1]] * c[2] : -1e9), best = bestOf(vals); return cell(st[i][c[1]], c[3](st[i][c[1]]), best !== null && vals[i] === best, c[4]); }).join('')
        + (good[i] === null ? '<td>…</td>' : cell(good[i] / 3.66, String(good[i]), bestOf(good.map(v => v === null ? -1e9 : v)) === good[i], true)) + '<td>' + (m ? (m.tiers[0] || '').replace('LOLA ', '') : '…') + '</td></tr>';
    });
    $('cmptbl').innerHTML = html + '</tbody>';
    // the same lanes as the timeline, one group per site
    const narrow = cv.clientWidth < 600; CMPP.l = narrow ? 92 : 150; CMPP.r = narrow ? 44 : 56;
    const ln = 14, lg = 8, head = 26, blockH = head + 3 * ln + 2 * lg + 18, top = 30;
    cv.style.height = (top + rs.length * blockH + 22) + 'px';
    const { g, w } = prep(cv), px = CMPP.l, pw = w - CMPP.l - CMPP.r, yEnd = top + rs.length * blockH - 12;
    gridX(g, px, pw, S.anchor, S.span, top, yEnd);
    rs.forEach((s, r) => {
      const se = ser(s), y = top + r * blockH;
      g.font = FONTS(14); g.fillStyle = C.ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(s.name, 0, y + 14, w);
      if (!se) { g.font = FONT(12); g.fillStyle = C.muted; g.fillText('loading…', px, y + head + 10); return; }
      const i1 = Math.min(a0 + nW, se.n - 1), wf = pw * Math.min(1, (se.n - 1 - a0) / nW);
      [[narrow ? 'Sun' : 'Sun up', C.sun, i => se.sunClr[i] > 0], [narrow ? 'Earth' : 'Earth in view', C.earth, i => se.earthClr[i] > 0], [narrow ? 'Both' : 'Sun and Earth', C.go, i => se.sunClr[i] > 0 && se.earthClr[i] > 0]].forEach(([t, col, pred], k) => {
        const yy = y + head + k * (ln + lg); g.fillStyle = C.cell; rbar(g, px, yy, pw, ln, 3); strip(g, pred, a0, i1, px, yy, wf, ln, col);
        g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'middle'; labTxt(g, t, px - 8, yy + ln / 2 + 1, 12);
        g.font = FONT(12); g.fillStyle = C.ink; g.textAlign = 'left'; g.fillText(Math.round(shareOf(pred, a0, i1)) + '%', px + pw + 8, yy + ln / 2 + 1);
      });
    });
    timeAxis(g, px, yEnd + 2, pw, S.anchor, S.span);
    const cx = px + (S.t - S.anchor) / (S.span * DAY) * pw; if (cx >= px - 1 && cx <= px + pw + 1) clockAt(g, cx, 0, yEnd, px - 40, px + pw + CMPP.r);
  }

  // ---------- compare: landing-date calendar (server: /calendar) ----------
  // One square per landing day. Each column of seven is a week (Monday at the top), grouped by month; months wrap to
  // more rows when the panel is narrow so a square stays big enough to tap.
  let calHover = null, CALG = null;
  function calLayout(w, nSites) {
    const nd = 366, months = [];
    for (let d = 0; d < nd; d++) {
      const t = S.calAnchor + d * DAY, dt = new Date(t), key = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      let m = months[months.length - 1]; if (!m || m.key !== key) { const first = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1); m = { key, mon: dt.getUTCMonth(), off: (new Date(first).getUTCDay() + 6) % 7, days: [] }; months.push(m); }
      m.days.push({ d, dom: dt.getUTCDate() });
    }
    months.forEach(m => { const c0 = Math.floor((m.off + m.days[0].dom - 1) / 7), c1 = Math.floor((m.off + m.days[m.days.length - 1].dom - 1) / 7); m.c0 = c0; m.nc = c1 - c0 + 1; });
    const narrow = w < 640, labW = narrow ? 0 : 150, mgap = 8, avail = w - labW;
    let perRow = months.length, pitch = 0;
    for (; perRow >= 1; perRow = Math.ceil(perRow / 2)) {
      let worst = 0; for (let i = 0; i < months.length; i += perRow) { const ms = months.slice(i, i + perRow); worst = Math.max(worst, ms.reduce((a, m) => a + m.nc, 0) + (ms.length - 1) * mgap / 11); }
      pitch = Math.min(18, Math.floor(avail / worst)); if (pitch >= 10 || perRow === 1) break;
    }
    const rowsM = []; for (let i = 0; i < months.length; i += perRow) rowsM.push(months.slice(i, i + perRow));
    const sq = Math.max(4, pitch - 2), monH = 18, gridH = 7 * pitch, headH = narrow ? 24 : 0;
    const blockH = headH + rowsM.length * (monH + gridH + 8) + 14;
    const cells = new Array(nd);
    rowsM.forEach((ms, ri) => { let x = labW; ms.forEach(m => { m.x = x; m.row = ri; m.days.forEach(({ d, dom }) => { const k = m.off + dom - 1; cells[d] = { x: x + (Math.floor(k / 7) - m.c0) * pitch, y: headH + ri * (monH + gridH + 8) + monH + (k % 7) * pitch }; }); x += m.nc * pitch + mgap; }); });
    return { nd, months, rowsM, pitch, sq, labW, narrow, blockH, cells, monH, gridH, headH, h: nSites * blockH };
  }
  function drawCalendar() {
    const cv = $('cal'); if (!shown(cv)) return;
    const rs = rows(), cal = calNow(), L = calLayout(cv.clientWidth, rs.length); cv.style.height = L.h + 'px';
    const { g } = prep(cv); CALG = L;
    const sel = Math.floor((S.t - S.calAnchor) / DAY);
    rs.forEach((s, r) => {
      const c = cal && cal[siteKey(s)], y0 = r * L.blockH;
      const pass = c ? c.state.filter(v => v === 2).length : null, marg = c ? c.state.filter(v => v === 1).length : null;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      if (L.narrow) {
        g.font = FONTS(14); g.fillStyle = C.ink; g.fillText(short(s), 0, y0 + 15); let x = g.measureText(short(s)).width + 12; g.font = FONT(12);
        if (c) { const a = pass + ' pass', b = marg + ' marginal'; g.fillStyle = C.go; g.fillText(a, x, y0 + 15); x += g.measureText(a).width + 10; g.fillStyle = C.warn; g.fillText(b, x, y0 + 15); } else { g.fillStyle = C.muted; g.fillText('computing…', x, y0 + 15); }
      } else {
        const ty = y0 + L.monH + 12; g.font = FONTS(14); g.fillStyle = C.ink; g.fillText(short(s), 0, ty, L.labW - 12); g.font = FONT(12);
        if (c) { g.fillStyle = C.go; g.fillText(pass + ' days pass', 0, ty + 22); g.fillStyle = C.warn; g.fillText(marg + ' marginal', 0, ty + 40); } else { g.fillStyle = C.muted; g.fillText('computing…', 0, ty + 22); }
      }
      // month names over each row of months
      g.font = FONT(12); g.fillStyle = C.muted; L.months.forEach(m => g.fillText(MON[m.mon], m.x, y0 + L.headH + m.row * (L.monH + L.gridH + 8) + 12));
      for (let d = 0; d < L.nd; d++) {
        const p = L.cells[d], v = c ? c.state[d] : 0; g.fillStyle = !c ? C.cell : v === 2 ? C.go : v === 1 ? hatch(g, C.cell) : C.cell;
        if (!c) g.globalAlpha = 0.5; rbar(g, p.x, y0 + p.y, L.sq, L.sq, 2); g.globalAlpha = 1;
      }
      for (const [d, col, lw] of [[calHover, C.muted, 1.5], [sel, C.ink, 2]]) { if (d === null || d < 0 || d >= L.nd) continue; const p = L.cells[d]; g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.roundRect ? g.roundRect(p.x - 1.5, y0 + p.y - 1.5, L.sq + 3, L.sq + 3, 3) : g.rect(p.x - 1.5, y0 + p.y - 1.5, L.sq + 3, L.sq + 3); g.stroke(); }
    });
    const d = calHover != null ? calHover : sel;
    if (cal && d >= 0 && d < L.nd) $('calread').innerHTML = 'Land on <b>' + fmtDate(S.calAnchor + d * DAY) + '</b> for ' + S.cfg.days + ' days: ' + rs.map(s => { const c = cal[siteKey(s)]; if (!c) return short(s) + ' …'; const v = c.state[d]; return short(s) + ' ' + (v === 2 ? 'passes' : v === 1 ? 'is marginal' : 'fails (' + c.cause[d] + ')'); }).join(', ') + '.';
    else $('calread').textContent = cal ? '' : 'Checking every landing day for each site…';
  }
  // which day square is under the pointer, or null
  function calDayAt(e) {
    if (!CALG) return null; const r = $('cal').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, L = CALG;
    const yIn = ((y % L.blockH) + L.blockH) % L.blockH, tol = (L.pitch - L.sq) / 2 + 1;
    for (let d = 0; d < L.nd; d++) { const p = L.cells[d]; if (x >= p.x - tol && x <= p.x + L.sq + tol && yIn >= p.y - tol && yIn <= p.y + L.sq + tol) return d; }
    return null;
  }
  const TER = createTerrain({ api, need, qs });

  // ---------- maps ----------
  const PS = 400, CAP = -80, RHO = 2 * RM * Math.tan((90 + CAP) / 2 * D2R), PXKM = 2 * RHO / PS;
  const pH = new Float32Array(PS * PS), pSL = new Float32Array(PS * PS), pCL = new Float32Array(PS * PS), pSO = new Float32Array(PS * PS), pCO = new Float32Array(PS * PS), pIn = new Uint8Array(PS * PS), pHill = new Float32Array(PS * PS);
  const pFrac = new Float32Array(PS * PS), pInc = new Float32Array(PS * PS), sunF = new Float32Array(PS * PS), sunI = new Float32Array(PS * PS); let sunFt = NaN, polarBuilt = false;
  const STEPS = []; for (let d = 1; d <= 8; d++) STEPS.push(d); for (let d = 9; d < 190; d *= 1.12) STEPS.push(d);
  const off = document.createElement('canvas'); off.width = off.height = PS; const offg = off.getContext('2d'); const img = offg.createImageData(PS, PS);
  function buildPolar() {
    for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
      const i = y * PS + x, Xk = (x + 0.5 - PS / 2) * PXKM, Yk = (PS / 2 - (y + 0.5)) * PXKM, rho = Math.hypot(Xk, Yk);
      const lat = -90 + 2 * Math.atan(rho / (2 * RM)) * R2D, lon = Math.atan2(Xk, Yk);
      pH[i] = TER.polarXY(Xk, Yk); pSL[i] = Math.sin(lat * D2R); pCL[i] = Math.cos(lat * D2R); pSO[i] = Math.sin(lon); pCO[i] = Math.cos(lon); pIn[i] = rho <= RHO ? 1 : 0;
    }
    for (let y = 1; y < PS - 1; y++) for (let x = 1; x < PS - 1; x++) {
      const i = y * PS + x, gx = (pH[i + 1] - pH[i - 1]) / (2 * PXKM * 1000), gy = (pH[i + PS] - pH[i - PS]) / (2 * PXKM * 1000);
      pHill[i] = Math.max(0, Math.min(1, 0.5 - 1.8 * (gx + gy)));
    }
    polarBuilt = true;
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
      pFrac[i] = discFrac(el, rad, Math.atan(mt) * R2D);
      const xa = Math.max(0, Math.min(PS - 1, Math.round(x + dx * 1.5))), ya = Math.max(0, Math.min(PS - 1, Math.round(y + dy * 1.5))), xb = Math.max(0, Math.min(PS - 1, Math.round(x - dx * 1.5))), yb = Math.max(0, Math.min(PS - 1, Math.round(y - dy * 1.5)));
      const gsl = (pH[ya * PS + xa] - pH[yb * PS + xb]) / (3 * PXKM * 1000);
      pInc[i] = Math.max(0, Math.sin((el + Math.atan(gsl) * R2D) * D2R));
    }
  }
  function sunRaster() { if (polarBuilt && S.now && sunFt !== S.t) { castPolar(S.now.sun, false, 0.266, sunF, sunI); sunFt = S.t; } }

  // ---------- explore: first-person surface view ----------
  const VW = { az: null, fov: 75, off: document.createElement('canvas'), drag: false, lit: {}, have: null, job: null, ref: [] };
  // The sharp picture is at most this many columns wide; the browser stretches it to the screen.
  const SURF_MAX = 2000;
  // Which ground is in sunlight: for each cell of a grid around the site, march toward the Sun over the terrain and
  // keep the steepest rise; the share of the solar disc above it is the light that cell gets. A cell is worked out the
  // first time the picture asks for it: most of a grid lies outside the field of view or behind a hill.
  function litGrid(x0, y0, ux, uy, sunEl, cell, n, tmax) { return { a: new Float32Array(n * n).fill(NaN), n, cell, x0, y0, ux, uy, sunEl, tmax }; }
  function litCell(g, k) {
    const n = g.n, half = (n - 1) / 2, i = k % n, j = (k - i) / n, cell = g.cell, ux = g.ux, uy = g.uy, H = TER.elevXY;
    const x = g.x0 + (i - half) * cell, y = g.y0 + (half - j) * cell, h1 = H(x, y);
    const el = g.sunEl + ((x - g.x0) * ux + (y - g.y0) * uy) / RM * R2D, top = Math.tan((el + 0.27) * D2R);
    let mt = -0.2;
    for (let t = cell * 0.75; t < g.tmax; t += Math.max(cell * 0.75, t * 0.06)) {
      const v = (H(x + ux * t, y + uy * t) - h1) / (1000 * t) - t / (2 * RM);
      if (v > mt) { mt = v; if (mt > top) break; }
    }
    return g.a[k] = discFrac(el, 0.266, Math.atan(mt) * R2D);
  }
  function litAtGrid(g, x, y) {
    const half = (g.n - 1) / 2, i = (x - g.x0) / g.cell + half, j = half - (y - g.y0) / g.cell;
    if (!(i >= 0 && j >= 0 && i < g.n - 1 && j < g.n - 1)) return NaN;
    const i0 = i | 0, j0 = j | 0, fi = i - i0, fj = j - j0, a = g.a, n = g.n, k = j0 * n + i0;
    let p = a[k], q = a[k + 1], r = a[k + n], s = a[k + n + 1];
    if (p !== p) p = litCell(g, k); if (q !== q) q = litCell(g, k + 1); if (r !== r) r = litCell(g, k + n); if (s !== s) s = litCell(g, k + n + 1);
    return (p * (1 - fi) + q * fi) * (1 - fj) + (r * (1 - fi) + s * fi) * fj;
  }
  // Fine surface texture below the 5 to 10 m resolution of the data. Illustrative only: it changes the brightness by a
  // few percent within a few hundred metres of the camera and never changes heights, shadows or any number.
  const hash2 = (i, j) => { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  function vnoise(x, y) {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function regolith(x, y, d) {
    const fade = Math.max(0, 1 - d / 0.4); if (fade <= 0) return 1;
    const m = x * 1000, n = y * 1000;   // metres
    const t = 0.55 * vnoise(m / 2.5, n / 2.5) + 0.3 * vnoise(m / 0.8, n / 0.8) + 0.15 * vnoise(m / 0.25, n / 0.25);
    const pebble = vnoise(m / 0.12, n / 0.12) > 0.82 ? 0.82 : 1;   // scattered small stones
    return (1 + fade * 0.3 * (t - 0.5)) * (fade > 0.3 ? pebble : 1);
  }
  function drawSurface() {
    const cv = $('surf'); if (!shown(cv)) return;
    const can = riskOk() && TER.ready() && TER.rings && siteMask(S.site) && S.now && S.cur;
    cv.style.height = (riskOk() ? Math.round(Math.max(220, Math.min(560, cv.clientWidth * (cv.clientWidth < 520 ? 0.66 : 0.42)))) : 96) + 'px';
    const { g, w, h } = prep(cv); if (!(w > 0 && h > 0)) return;   // mid-resize or not laid out yet
    g.fillStyle = C.sky; g.fillRect(0, 0, w, h);
    if (!riskOk()) { g.fillStyle = C.skyMuted; g.font = FONT(13); g.textAlign = 'center'; g.fillText('The surface view needs the polar terrain, which covers 80°S to the south pole.', w / 2, h / 2); $('surfcap').textContent = 'Pick a south-pole site to stand on the surface. The sky chart shows the horizon for any site.'; return; }
    if (!can) { g.fillStyle = C.skyMuted; g.font = FONT(13); g.textAlign = 'center'; g.fillText('Loading the terrain around the site…', w / 2, h / 2); return; }
    const c = S.cur, m = siteMask(S.site), mask = m.mask, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (VW.az === null) { const sepA = wrap180(c.earthAz - c.sunAz); VW.az = Math.abs(sepA) <= 0.86 * VW.fov ? c.sunAz + sepA / 2 : c.sunAz + VW.fov * 0.24; }
    const live = S.playing || S.scrubbing || VW.drag, fovH = VW.fov, fovV = fovH * h / w, elC = -0.02 * fovV;
    const lam = S.site.lon * D2R, nx = Math.sin(lam), ny = Math.cos(lam), ex = Math.cos(lam), ey = -Math.sin(lam);
    const rho0 = 2 * RM * Math.tan((90 + Math.max(-89.999, S.site.lat)) / 2 * D2R), x0 = rho0 * nx, y0 = rho0 * ny, hEye = m.h0 + S.eye;
    const sa = c.sunAz * D2R, ux = nx * Math.cos(sa) + ex * Math.sin(sa), uy = ny * Math.cos(sa) + ey * Math.sin(sa), E = TER.elevXYsmooth;
    // The terrain picture is drawn in two passes. A quick draft (fewer columns, coarser shadows) is painted at once, and
    // it is all that is drawn while time plays or the view is dragged. The sharp picture is then worked out in the
    // background a few columns at a time, so the page never freezes, and replaces the draft when it is complete.
    // A picture is kept until something it depends on changes: a redraw for any other reason only repaints the labels.
    const sharpW = Math.max(1, Math.min(SURF_MAX, Math.round(w * dpr))), draftW = Math.max(1, Math.min(sharpW, Math.round(w * Math.min(dpr, 1) * 0.6)));
    // shadows: fine near the site, coarser farther out, then the polar shadow map.
    // The draft's shadows are recomputed every 30 minutes of mission time instead of every frame.
    const lit = sharp => {
      // turning the view does not move the shadows: the draft reuses the sharp ones when they are for this exact time
      if (!sharp && VW.lit.sharp && VW.lit.sharp.key === [S.site.lat, S.site.lon, S.t].join('|')) return VW.lit.sharp;
      const slot = sharp ? 'sharp' : 'draft', key = [S.site.lat, S.site.lon, sharp ? S.t : Math.round(S.t / 1800e3)].join('|');
      let L = VW.lit[slot];
      if (!L || L.key !== key) {
        sunRaster();
        L = VW.lit[slot] = { key,
          // the ground next to the lander needs 10 m shadows in the draft too: coarse cells put a rim site in shadow
          fine: litGrid(x0, y0, ux, uy, c.sunEl, 0.01, sharp ? 300 : 150, 12),
          near: litGrid(x0, y0, ux, uy, c.sunEl, sharp ? 0.04 : 0.12, sharp ? 300 : 100, 40),
          far: litGrid(x0, y0, ux, uy, c.sunEl, sharp ? 0.2 : 0.6, sharp ? 300 : 100, 160) };
      }
      return L;
    };
    // one column of the picture: march outward from the camera and paint the ground from the bottom of the screen up
    const columns = (Wc, Hc, buf, sharp) => {
      const L = lit(sharp), stepK = sharp ? 1 : 2, rowsPerDeg = Hc / fovV;
      const litAt = (x, y) => {
        let v = L.fine ? litAtGrid(L.fine, x, y) : NaN; if (v === v) return v;
        v = litAtGrid(L.near, x, y); if (v === v) return v;
        v = litAtGrid(L.far, x, y); if (v === v) return v;
        const px = Math.floor(x / PXKM + PS / 2), py = Math.floor(PS / 2 - y / PXKM); return px >= 0 && py >= 0 && px < PS && py < PS ? sunF[py * PS + px] : 1;
      };
      const Y = el => (0.5 - (el - elC) / fovV) * Hc, expo = 1 / (6 * Math.sin(Math.max(0.6, c.sunEl) * D2R)), az0 = VW.az, sunEl = c.sunEl;
      const mix = (c1, c2, f) => 0xff000000 | (((c1 >> 16 & 255) * f + (c2 >> 16 & 255) * (1 - f)) << 16) | (((c1 >> 8 & 255) * f + (c2 >> 8 & 255) * (1 - f)) << 8) | ((c1 & 255) * f + (c2 & 255) * (1 - f));
      return col => {
        const az = az0 + ((col + 0.5) / Wc - 0.5) * fovH, a = az * D2R, dx = nx * Math.cos(a) + ex * Math.sin(a), dy = ny * Math.cos(a) + ey * Math.sin(a), toSun = Math.cos(a - sa);
        // the painted horizon agrees exactly with the server's horizon used for every number on the page
        const ymF = Math.max(0, Math.min(Hc, Y(maskAt(mask, az)))), ym = Math.floor(ymF);
        let yb = Hc, last = 0xff0a0a0a, lastV = -1, pr = -1, pf = 0, pc = 0;
        // Nothing is kept above that horizon, so the march stops as soon as the ground drawn so far has reached it.
        for (let d = 0.003; d < 300 && yb > 0 && yb >= ym;) {
          const res = TER.resAt(d), x = x0 + dx * d, y = y0 + dy * d, hh = E(x, y), pyF = Y(Math.atan((hh - hEye) / (1000 * d) - d / (2 * RM)) * R2D), py = Math.floor(pyF);
          // step: fine enough for the terrain at this distance, and no more than about one pixel row on screen
          const rowsPerKm = (Math.abs(hh - hEye) / 1000 / (d * d) + 1 / (2 * RM)) * R2D * rowsPerDeg;
          d += stepK * Math.min(Math.max(res * 0.5, d * (d > 25 ? 0.0035 : 0.006)), Math.max(0.00002, 1.1 / rowsPerKm));
          if (py >= yb) { lastV = -1; continue; }   // hidden behind nearer ground: never blend across a silhouette
          // ground normal at a scale tied to distance, so the 5 m and 10 m detail near the site shows without banding
          const dl = Math.min(0.25, Math.max(0.006, d * 0.012)), gx = (E(x + dl, y) - E(x - dl, y)) / (2000 * dl), gy = (E(x, y + dl) - E(x, y - dl)) / (2000 * dl);
          const elL = (sunEl + (d / RM) * toSun * R2D) * D2R, chh = Math.cos(elL), lam2 = Math.max(0, (-gx * ux * chh - gy * uy * chh + Math.sin(elL)) / Math.sqrt(1 + gx * gx + gy * gy));
          const q = litAt(x, y) * lam2 * expo * 1.7 * regolith(x, y, d), v = 6 + 249 * Math.pow(q / (1 + q), 0.72);
          last = 0xff000000 | ((v * 0.9) << 16) | ((v * 0.96) << 8) | v;
          if (pr >= 0) buf[pr * Wc + col] = mix(pc, last, pf);
          // fill the rows down to the previous sample, blending toward its brightness, so steps never show as bands
          const span = yb - (py + 1), contiguous = lastV >= 0 && span <= 6;
          for (let r = Math.max(0, py + 1); r < yb; r++) {
            const vv = contiguous ? v + (lastV - v) * ((r - py) / (span + 1)) : v;
            buf[r * Wc + col] = 0xff000000 | ((vv * 0.9) << 16) | ((vv * 0.96) << 8) | vv;
          }
          if (py >= 0) { buf[py * Wc + col] = last; pr = py; pf = py + 1 - pyF; pc = last; } else pr = -1;
          yb = py; lastV = v;
        }
        if (yb > ym) for (let r = ym; r < Math.min(Hc, yb); r++) buf[r * Wc + col] = last; else for (let r = Math.max(0, yb); r < ym; r++) buf[r * Wc + col] = 0;
        if (ym >= 0 && ym < Hc) buf[ym * Wc + col] = (buf[ym * Wc + col] & 0x00ffffff) | (Math.round(255 * (ym + 1 - ymF)) << 24);
      };
    };
    const off = VW.off, stopJob = () => { if (VW.job) { clearTimeout(VW.job.timer); VW.job.dead = true; VW.job = null; } };
    const store = (im, Wc, Hc) => { if (off.width !== Wc || off.height !== Hc) { off.width = Wc; off.height = Hc; } off.getContext('2d').putImageData(im, 0, 0); };
    const draft = () => {
      const t0 = performance.now(), Wc = draftW, Hc = Math.max(1, Math.round(Wc * h / w)), im = new ImageData(Wc, Hc), col = columns(Wc, Hc, new Uint32Array(im.data.buffer), false);
      for (let i = 0; i < Wc; i++) col(i);
      store(im, Wc, Hc);
      if (DEBUG) console.log('surface view: draft, ' + Wc + ' columns in ' + Math.round(performance.now() - t0) + ' ms');
    };
    const sharpen = key => {
      const Wc = sharpW, Hc = Math.max(1, Math.round(Wc * h / w)), im = new ImageData(Wc, Hc), col = columns(Wc, Hc, new Uint32Array(im.data.buffer), true);
      const job = VW.job = { key, dead: false, timer: 0, next: 0, work: 0, t0: performance.now() };
      const slice = () => {
        if (job.dead) return;
        const t = performance.now(); do col(job.next++); while (job.next < Wc && performance.now() - t < 12);
        job.work += performance.now() - t;
        if (job.next < Wc) { job.timer = setTimeout(slice, 0); return; }
        store(im, Wc, Hc); VW.have = { key, sharp: true }; VW.job = null;
        if (DEBUG) console.log('surface view: sharp, ' + Wc + ' columns in ' + Math.round(job.work) + ' ms of work over ' + Math.round(performance.now() - job.t0) + ' ms');
        drawSurface();
      };
      job.timer = setTimeout(slice, 30);   // the draft reaches the screen first
    };
    // what the picture depends on (the Sun's direction to 0.05 deg: the exact /sky answer replaces the interpolated one without a redraw)
    const ref = [mask, TER.rings, TER.polar], key = [S.site.lat, S.site.lon, S.t, S.eye, VW.az.toFixed(3), fovH, w, h, sharpW, Math.round(c.sunAz * 20), Math.round(c.sunEl * 20)].join('|');
    if (ref.some((r, i) => r !== VW.ref[i])) { VW.ref = ref; VW.have = null; VW.lit = {}; stopJob(); }
    if (live) { stopJob(); draft(); VW.have = { key, sharp: false }; }
    else if (!VW.have || VW.have.key !== key) { stopJob(); draft(); VW.have = { key, sharp: false }; sharpen(key); }
    else if (!VW.have.sharp && !VW.job) sharpen(key);
    const X = az => (wrap180(az - VW.az) / fovH + 0.5) * w, Yc = el => (0.5 - (el - elC) / fovV) * h, ppd = w / fovH;
    const sep = Math.acos(Math.max(-1, Math.min(1, Math.sin(c.sunEl * D2R) * Math.sin(c.earthEl * D2R) + Math.cos(c.sunEl * D2R) * Math.cos(c.earthEl * D2R) * Math.cos((c.sunAz - c.earthAz) * D2R)))), k = (1 - Math.cos(sep)) / 2;
    const exs = X(c.earthAz), eys = Yc(c.earthEl), re = Math.max(3, c.earthRad * ppd), sxs = X(c.sunAz), sys = Yc(c.sunEl), rs = Math.max(1.6, c.sunRad * ppd);
    g.save(); g.translate(exs, eys); g.rotate(Math.atan2(-(c.sunEl - c.earthEl), wrap180(c.sunAz - c.earthAz) * Math.cos(c.earthEl * D2R)));
    g.fillStyle = '#0d1f3d'; g.beginPath(); g.arc(0, 0, re, 0, 7); g.fill();
    g.fillStyle = '#5b9cf0'; g.beginPath(); g.arc(0, 0, re, -Math.PI / 2, Math.PI / 2, false); g.ellipse(0, 0, Math.abs(1 - 2 * k) * re, re, 0, Math.PI / 2, -Math.PI / 2, k < 0.5); g.closePath(); g.fill(); g.restore();
    const gl = g.createRadialGradient(sxs, sys, rs, sxs, sys, Math.max(26, rs * 7)); gl.addColorStop(0, 'rgba(255,240,205,0.9)'); gl.addColorStop(0.25, 'rgba(255,225,160,0.28)'); gl.addColorStop(1, 'rgba(255,220,150,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(sxs, sys, Math.max(26, rs * 7), 0, 7); g.fill(); g.fillStyle = '#fffaf0'; g.beginPath(); g.arc(sxs, sys, rs, 0, 7); g.fill();
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(off, 0, 0, w, h);
    g.font = FONTC(13); g.textBaseline = 'middle';
    const tag = (t, x, y, col, hidden, r) => {
      if (x < -20 || x > w + 20) return; if (hidden) { g.setLineDash([3, 3]); g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, Math.max(6, r), 0, 7); g.stroke(); g.setLineDash([]); }
      const tw = g.measureText(t).width, lx = x + r + 8 + tw > w - 4 ? x - r - 8 - tw : x + r + 8, ly = Math.max(10, Math.min(h - 26, y - r - 6)); g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = C.sky; g.strokeText(t, lx, ly); g.fillStyle = col; g.fillText(t, lx, ly);
    };
    tag(c.earthClr > 0 ? 'Earth' : 'Earth, behind the terrain', exs, eys, C.skyEarth, c.earthClr <= 0, re);
    tag(c.sunClr > 0 ? 'Sun' : 'Sun, behind the terrain', sxs, sys, C.skySun, c.sunClr <= 0, rs);
    if (VW.job) { g.font = FONT(11); g.textAlign = 'right'; g.fillStyle = C.skyMuted; g.fillText('Sharpening…', w - 10, 14); }
    g.font = FONT(10); g.fillStyle = C.skyMuted; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const stepA = fovH > 70 ? 15 : fovH > 40 ? 10 : 5;
    for (let a = Math.ceil((VW.az - fovH / 2) / stepA) * stepA; a <= VW.az + fovH / 2; a += stepA) { const x = (a - VW.az) / fovH * w + w / 2, aa = ((a % 360) + 360) % 360; g.beginPath(); g.moveTo(x, h - 4); g.lineTo(x, h - 9); g.stroke(); g.fillText(aa % 90 === 0 ? ['N', 'E', 'S', 'W'][aa / 90] : aa + '°', Math.max(12, Math.min(w - 12, x)), h - 12); }
    g.textAlign = 'left'; g.textBaseline = 'middle'; const stepE = fovV > 30 ? 5 : fovV > 12 ? 2 : 1;
    for (let e = Math.ceil((elC - fovV / 2) / stepE) * stepE; e <= elC + fovV / 2; e += stepE) { const y = Yc(e); if (y < 10 || y > h - 26) continue; g.beginPath(); g.moveTo(0, y); g.lineTo(5, y); g.stroke(); g.fillText((e > 0 ? '+' : e < 0 ? '−' : '') + Math.abs(e) + '°', 8, y); }
    const rg = cache.get('rings|' + S.site.lat.toFixed(5) + ',' + S.site.lon.toFixed(5)), tier = rg && rg.v ? rg.v.tier : '';
    $('surfcap').textContent = 'The view from ' + S.eye + ' m above the ground at ' + short(S.site) + ', ' + fmtDT(S.t) + ', ' + Math.round(fovH) + '° wide. Terrain and shadows from NASA\'s LOLA height maps (' + (tier || 'LOLA') + ' at the site); the Sun and Earth are drawn at their true sizes and nothing is stretched. There is no air, so far hills look as sharp as near ones. Texture finer than the height map is illustrative. Drag sideways to look around.';
  }
  function polarXY(lat, lon, R, cx, cy) { const rho = 2 * RM * Math.tan((90 + lat) / 2 * D2R) / RHO * R; return [cx + rho * Math.sin(lon * D2R), cy - rho * Math.cos(lon * D2R)]; }
  let mapGeom = null;
  function glyph(g, x, y, kind) {
    if (kind === 'sun') { g.fillStyle = '#ffe2a0'; g.strokeStyle = C.skySun; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.stroke(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g.beginPath(); g.moveTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); g.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); g.stroke(); } }
    else { g.fillStyle = '#3f7fd8'; g.strokeStyle = C.skyEarth; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); g.stroke(); g.beginPath(); g.moveTo(x - 7, y); g.lineTo(x + 7, y); g.moveTo(x, y - 7); g.lineTo(x, y + 7); g.lineWidth = 1; g.stroke(); }
  }
  function markers(g, proj, filt) {
    const rs = rows().map(s => s.id), hits = [];
    const list = SITES.filter(filt); if (S.site.id === 'custom' && filt(S.site)) list.push(S.site);
    list.forEach(s => {
      const [x, y] = proj(s.lat, s.lon), sel = s.id === S.site.id, cmp = rs.includes(s.id);
      hits.push({ x, y, s });
      g.beginPath(); g.arc(x, y, sel ? 5 : 3, 0, 7); g.fillStyle = sel ? C.skyInk : cmp ? C.skyGo : C.skyMuted; g.fill(); g.strokeStyle = C.sky; g.lineWidth = 1; g.stroke();
      if (sel) { g.beginPath(); g.arc(x, y, 10, 0, 7); g.strokeStyle = C.skyInk; g.lineWidth = 1.5; g.stroke(); }
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
      g.textAlign = 'left'; g.lineWidth = 3; g.strokeStyle = C.sky; g.strokeText(t, bx, by); g.fillStyle = C.skyInk; g.fillText(t, bx, by);
    });
    return hits;
  }
  let texImg = null, nightCv = null;
  // ---------- explore: 3D globe ----------
  const GL = { lat: -30, lon: 0, tex: null, tw: 0, th: 0, off: document.createElement('canvas'), drag: false, moved: false };
  function globeBasis() {
    const la = GL.lat * D2R, lo = GL.lon * D2R, cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    return { F: [cl * co, cl * so, sl], Rt: [-so, co, 0], U: [-sl * co, -sl * so, cl] };
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
        const d = p0 * su[0] + p1 * su[1] + p2 * su[2], k = Math.max(0, Math.min(1, (d + 0.02) / 0.1)), day = k * k * (3 - 2 * k);
        const es = Math.max(0, p0 * eu[0] + p1 * eu[1] + p2 * eu[2]) * 0.07;
        const lit = (0.05 + es) * (1 - day) + (0.62 + 0.38 * Math.sqrt(Math.max(0, d))) * day, v = t * lit * (0.82 + 0.18 * z) * 1.25;
        dd[o] = Math.min(255, v); dd[o + 1] = Math.min(255, v * 0.98); dd[o + 2] = Math.min(255, v * (0.94 + 0.5 * es * (1 - day)));
        dd[o + 3] = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * R)) * 255;
      }
    }
    og.putImageData(im, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(off, cx - Rp, cy - Rp, 2 * Rp, 2 * Rp);
    const proj = v => { const z = v[0] * F[0] + v[1] * F[1] + v[2] * F[2]; return { x: cx + (v[0] * Rt[0] + v[1] * Rt[1]) * Rp, y: cy - (v[0] * U[0] + v[1] * U[1] + v[2] * U[2]) * Rp, z }; };
    const a1 = unit(Math.abs(eu[2]) < 0.9 ? [-eu[1], eu[0], 0] : [0, -eu[2], eu[1]]), a2 = [eu[1] * a1[2] - eu[2] * a1[1], eu[2] * a1[0] - eu[0] * a1[2], eu[0] * a1[1] - eu[1] * a1[0]];
    g.strokeStyle = C.skyEarth; g.lineWidth = 1.6; g.setLineDash([5, 4]); g.beginPath(); let pen = false;
    for (let b = 0; b <= 360; b += 2) { const cb = Math.cos(b * D2R), sb = Math.sin(b * D2R), q = proj([a1[0] * cb + a2[0] * sb, a1[1] * cb + a2[1] * sb, a1[2] * cb + a2[2] * sb]); if (q.z < 0) { pen = false; continue; } pen ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); pen = true; }
    g.stroke(); g.setLineDash([]);
    g.font = FONTC(12, 500); g.textBaseline = 'middle'; g.textAlign = 'center';
    [['N', [0, 0, 1]], ['S', [0, 0, -1]]].forEach(([t, v]) => { const q = proj(v); if (q.z < 0) return; g.strokeStyle = C.skyInk; g.lineWidth = 1; g.beginPath(); g.moveTo(q.x - 4, q.y); g.lineTo(q.x + 4, q.y); g.moveTo(q.x, q.y - 4); g.lineTo(q.x, q.y + 4); g.stroke(); g.lineWidth = 3; g.strokeStyle = C.sky; g.strokeText(t, q.x + 10, q.y - 8); g.fillStyle = C.skyInk; g.fillText(t, q.x + 10, q.y - 8); });
    mapGeom = { globe: true, cx, cy, R: Rp, w, h, hits: [] };
    const front = s => proj(llVec(s.lat, s.lon)).z > 0.02;
    mapGeom.hits = markers(g, (la, lo) => { const q = proj(llVec(la, lo)); return [q.x, q.y]; }, front);
    [['sun', su, 'Sun', C.skySun], ['earth', eu, 'Earth', C.skyEarth]].forEach(([kind, v, name, col]) => {
      const q = proj(v), dx = q.x - cx, dy = q.y - cy, L = Math.hypot(dx, dy), on = q.z > 0 && L < Rp * 0.9;
      const x = on ? q.x : cx + dx / (L || 1) * (Rp + 14), y = on ? q.y : cy + dy / (L || 1) * (Rp + 14);
      glyph(g, x, y, kind);
      const t = on ? name + ' overhead' : 'To ' + (kind === 'sun' ? 'the Sun' : 'Earth'); g.font = FONTC(12, 500); const twd = g.measureText(t).width, lx = Math.max(4, Math.min(w - twd - 4, x - twd / 2)), ly = y > cy ? Math.min(h - 8, y + 20) : Math.max(8, y - 20);
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = C.sky; g.strokeText(t, lx, ly); g.fillStyle = col; g.fillText(t, lx, ly);
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
    const { g, w, h } = prep(cv); g.fillStyle = C.sky; g.fillRect(0, 0, w, h);
    $('m-pole').classList.toggle('on', polar); $('m-globe').classList.toggle('on', S.mapTab === 'globe'); $('m-flat').classList.toggle('on', S.mapTab === 'flat'); $('layerseg').hidden = !polar;
    cv.style.cursor = S.mapTab === 'globe' ? 'grab' : 'crosshair'; cv.style.touchAction = S.mapTab === 'globe' ? 'none' : '';
    if (!S.now) { g.fillStyle = C.skyMuted; g.font = FONT(13); g.textAlign = 'center'; g.fillText('Loading the ephemeris…', w / 2, h / 2); return; }
    if (S.mapTab === 'globe') { $('maplegend').innerHTML = '<li><i class="key dash" style="border-color:var(--earth)"></i>Edge of Earth\'s view</li><li><i style="width:12px;height:12px;border:2px solid var(--ink);border-radius:50%;background:transparent"></i>Selected site</li>'; cv.style.height = cw + 'px'; const p = prep(cv); p.g.fillStyle = C.sky; p.g.fillRect(0, 0, p.w, p.h); drawGlobe(p.g, p.w, p.h); return; }
    $('l-sun').classList.toggle('on', S.layer === 'sun'); $('l-earth').classList.toggle('on', S.layer === 'earth');
    const ss = subPoint(S.now.sun), sE = subPoint(S.now.earth);
    if (polar) {
      if (!polarBuilt) { g.fillStyle = C.skyMuted; g.font = FONT(13); g.textAlign = 'center'; g.fillText('Loading the polar terrain…', w / 2, h / 2); return; }
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
      g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1; g.font = FONT(10); g.fillStyle = C.skyMuted; g.textAlign = 'left'; g.textBaseline = 'middle';
      for (const la of [-88, -86, -84, -82, -80]) { const rr = 2 * RM * Math.tan((90 + la) / 2 * D2R) / RHO * R; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke(); if (la > -88 && la < -80) { g.lineWidth = 3; g.strokeStyle = C.sky; g.strokeText(Math.abs(la) + '°S', cx + 3, cy + rr - 7); g.fillText(Math.abs(la) + '°S', cx + 3, cy + rr - 7); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.16)'; } }
      for (let lo = 0; lo < 360; lo += 45) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + R * Math.sin(lo * D2R), cy - R * Math.cos(lo * D2R)); g.stroke(); }
      g.textAlign = 'center'; g.fillStyle = C.skyMuted; g.font = FONTC(12, 500);
      [['0° · NEAR SIDE', 0], ['90°E', 90], ['180° · FAR SIDE', 180], ['90°W', 270]].forEach(([t, lo]) => { const rr = R + 10; let x = cx + rr * Math.sin(lo * D2R), y = cy - rr * Math.cos(lo * D2R); if (lo === 90 || lo === 270) { g.save(); g.translate(x, y); g.rotate(lo === 90 ? Math.PI / 2 : -Math.PI / 2); g.fillText(t, 0, 0); g.restore(); } else g.fillText(t, x, y); });
      mapGeom = { polar: true, cx, cy, R, w, h, hits: [] };
      mapGeom.hits = markers(g, (la, lo) => polarXY(la, lo, R, cx, cy), s => s.lat <= CAP);
      glyph(g, cx + (R - 12) * Math.sin(ss.lon * D2R), cy - (R - 12) * Math.cos(ss.lon * D2R), 'sun');
      glyph(g, cx + (R - 12) * Math.sin(sE.lon * D2R), cy - (R - 12) * Math.cos(sE.lon * D2R), 'earth');
      // scale bar: 50 km, bottom left
      const kmPx = R / RHO, sb = 50 * kmPx; g.strokeStyle = C.skyInk; g.lineWidth = 2; g.beginPath(); g.moveTo(12, h - 14); g.lineTo(12 + sb, h - 14); g.moveTo(12, h - 18); g.lineTo(12, h - 10); g.moveTo(12 + sb, h - 18); g.lineTo(12 + sb, h - 10); g.stroke();
      g.font = FONT(12); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.lineWidth = 4; g.strokeStyle = C.sky; g.strokeText('50 km', 12, h - 24); g.fillStyle = C.skyInk; g.fillText('50 km', 12, h - 24);
      $('maplegend').innerHTML = earth ? '<li><i style="background:rgb(60,135,235)"></i>Earth in view now</li><li><i style="background:rgb(30,32,42)"></i>Earth hidden by terrain</li><li><i style="width:12px;height:12px;border:2px solid var(--ink);border-radius:50%;background:transparent"></i>Selected site</li>'
        : '<li><i style="background:rgb(255,236,200)"></i>Sunlit now</li><li><i style="background:rgb(30,32,42)"></i>In shadow</li><li><i style="width:12px;height:12px;border:2px solid var(--ink);border-radius:50%;background:transparent"></i>Selected site</li>';
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
      circle(ss, C.skySun, []); circle(sE, C.skyEarth, [5, 4]);
      mapGeom = { polar: false, w, h, hits: [] }; mapGeom.hits = markers(g, proj, () => true);
      const a = proj(ss.lat, ss.lon), b = proj(sE.lat, sE.lon); glyph(g, a[0], a[1], 'sun'); glyph(g, b[0], b[1], 'earth');
      $('maplegend').innerHTML = '<li><i class="key" style="border-color:var(--sun)"></i>Day and night line</li><li><i class="key dash" style="border-color:var(--earth)"></i>Edge of Earth\'s view</li><li><i style="width:12px;height:12px;border:2px solid var(--ink);border-radius:50%;background:transparent"></i>Selected site</li>';
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
    const c = S.cfg, m = siteMask(S.site) || { h0: 0, lo: 0, hi: 0, tiers: [] }, mv = S.mv && !S.mv.pending ? S.mv : null, rq = rescueNow(), r = rq.r, L = [];
    L.push('# Mons Carlo mission report', '', 'Generated ' + fmtDT(Date.now()) + '.', '');
    L.push('## Scenario', '- Site: ' + S.site.name + ' (' + fmtLat(S.site.lat) + ', ' + fmtLon(S.site.lon) + '), terrain height ' + Math.round(m.h0) + ' m, mast ' + S.eye + ' m', '- Terrain: ' + tierText(m) + ', ' + sg(m.lo, 1) + ' to ' + sg(m.hi, 1), mv ? '- Landing: ' + fmtDT(mv.t) : '- Landing: ' + fmtDT(landingTime()), '- Surface mission: ' + c.days + ' days', '');
    L.push('## Mission needs', '- Lander: ' + (presetOf(S.landerId) ? presetOf(S.landerId).name : S.landerId) + (S.landerEdited ? ' (edited)' : ''), '- Solar array: ' + c.peakW + ' W in full Sun, ' + ARRN[c.arrayType], '- Load: ' + c.loadSun + ' W in sunlight, ' + c.loadDark + ' W in darkness', '- Battery: ' + c.capWh + ' Wh, reserve ' + Math.round(c.minSoc * 100) + '%, charge efficiency ' + Math.round(c.chargeEff * 100) + '%',
      '- Direct Earth link: ' + (c.needEarth ? 'required, longest gap ' + c.maxGapH + ' h' + (c.useDsn ? ', through the Deep Space Network' : '') : 'not required'), '- Terrain margin: ' + c.margin + '° added to every horizon', '');
    if (c.fault.kind !== 'none' || c.safe) L.push('## Contingency', '- ' + $('mv-fault').textContent, '');
    if (mv) {
      L.push('## Verdict: ' + STL[mv.st], '- Lowest battery: ' + Math.round(mv.nom.minSoc * 100) + '% on mission day ' + (mv.nom.kMin / 24).toFixed(1) + ' (' + Math.round(mv.rob.minSoc * 100) + '% with the terrain margin)', '- Battery needed to ride out the longest shortfall: ' + fmtWh(mv.nom.battNeedWh),
        '- Time in sunlight: ' + mv.nom.litPct.toFixed(0) + '%, longest dark stretch ' + fmtH(mv.nom.maxDarkH), '- Earth line of sight: ' + mv.nom.linkPct.toFixed(0) + '% of the mission, longest gap ' + fmtH(mv.nom.maxGapH));
      if (mv.nom.fails.length) L.push('- Fails because ' + mv.nom.fails.join('; ')); else if (mv.rob.fails.length) L.push('- With the terrain margin: ' + mv.rob.fails.join('; '));
      L.push('');
    }
    if (LAB.F) L.push('## Mission design', '- Battery needed with ' + fmtW(c.peakW) + ' of solar: ' + (LAB.cb === null ? 'no size is enough' : fmtWh(LAB.cb)), '- Solar output needed with a ' + fmtWh(c.capWh) + ' battery: ' + (LAB.pa === null ? 'no amount is enough' : fmtW(LAB.pa)), '- Blackout rule: ride out ' + c.autonomyH + ' h at the dark-time load from the lowest charge', '');
    const k = riskOk() ? riskNow() : null;
    if (k && !k.pending && !k.stale) {
      L.push('## Landing risk (Monte Carlo)', '- Chance of success: ' + Math.round(k.p * 100) + '% (95% interval ' + ciTxt(k.lo, k.hi) + ', reflecting the number of simulated missions only), from ' + k.total.toLocaleString('en-US') + ' simulated missions, seed ' + S.sig.seed,
        '- Spreads (3 sigma): touchdown within ' + S.acc + ' m, landing time within ' + S.tjit + ' h; 1 sigma: terrain ' + S.sig.terrain + '°, array output ' + S.sig.power + '%, loads ' + S.sig.load + '%, battery ' + S.sig.cap + '%' + (S.sig.corr ? ', loads and battery linked' : '') + '; steepest safe slope ' + S.sig.slope + '°',
        '- Failure causes: ' + CAUSES.map((nm, j) => nm.toLowerCase() + ' ' + Math.round(k.causes[j] * 100) + '%').slice(0, 5).join(', '),
        '- If one thing were known exactly: ' + k.drivers.map(d => d[0].toLowerCase() + ' ' + Math.round(d[1] * 100) + '%').join(', '),
        k.best.clear ? '- Best aim point nearby (checked on separate draws): ' + Math.round(k.best.p * 100) + '% at ' + fmtLat(k.best.lat) + ' ' + fmtLon(k.best.lon) + ' (' + fmtDist(k.best.dist) + ' away)' : '- No better aim point found within ' + fmtDist(1.5 * k.Rkm), '');
    }
    if (r) {
      L.push('## Mission Rescue', 'Plan: ' + S.plan.site.name + ', landing ' + fmtDT(S.plan.t) + ' (' + STN[r.plan.state].toLowerCase() + '). After a ' + S.slip + '-day slip at the same site: ' + STN[r.after_slip.state].toLowerCase() + (r.after_slip.state === 0 ? ', ' + r.after_slip.reasons[0] : '') + '.', '',
        '| # | Site | Land on (UTC) | Extra wait | Verdict | Lowest battery | Longest link gap | Terrain |', '|---|---|---|---|---|---|---|---|');
      r.alternatives.slice(0, 8).forEach((a, k2) => L.push('| ' + (k2 + 1) + ' | ' + a.location.name.split(',')[0] + ' | ' + (a.state ? fmtDT(Date.parse(a.landing_time)).replace(' UTC', '') : 'none') + ' | ' + (a.state ? '+' + a.extra_wait_days.toFixed(2) + ' d' : 'n/a') + ' | ' + STN[a.state] + ' | ' + Math.round(a.nominal.min_soc * 100) + '% | ' + fmtH(a.nominal.longest_link_gap_h) + ' | ' + (a.terrain || '') + ' |'));
      L.push('');
    }
    L.push('## Method and limits', '- Sun and Earth positions: JPL Horizons (fetched month by month and cached by the Mons Carlo server; JPL SPICE DE440 kernels when Horizons is unreachable); checked against JPL DE421 through SPICE to 0.00002°.',
      '- Terrain: NASA LOLA elevation models: 5 m site maps where they exist, the 80 m south-pole model from 80°S, the 240 m model from 60°S, and a coarse LOLA grid elsewhere. HorizonMasks are ray-cast on the server, 720 directions out to 330 km.',
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
    document.body.dataset.view = S.view;
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
    S.site = byId(id) || SITES[0]; VW.az = null;
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
    q.set('m', MKEYS.map(k => k[1](c)).join('_')); q.set('f', ({ flat: 0, track: 1, vert: 2 })[c.arrayType] + '_' + (c.needEarth ? 1 : 0) + '_' + (c.useDsn ? 1 : 0)); q.set('l', S.landerId); if (c.fault.kind !== 'none' || c.safe) q.set('x', [c.fault.kind, c.fault.day, c.safe ? 1 : 0].concat(c.fault.kind === 'custom' ? [c.fault.array_loss_pct, c.fault.extra_load_w, c.fault.battery_loss_pct, c.fault.comms_outage_h] : []).join('_'));
    if (c.strict) q.set('s', '1'); if (c.heat) q.set('h', '1');
    return location.href.split('#')[0] + '#' + S.view + '?' + q.toString();
  }
  function applyLink() {
    const h = location.hash.slice(1), k = h.indexOf('?'); if (k < 0) return false;
    let q; try { q = new URLSearchParams(h.slice(k + 1)); } catch (_) { return false; }
    const v = hashView(); if (VIEWS.includes(v)) S.view = v;
    const m = (q.get('m') || '').split('_'); if (m.length === MKEYS.length && m.every(x => isFinite(parseFloat(x)))) MKEYS.forEach((kk, i) => { $(kk[0]).value = m[i]; });
    if (q.get('l') && LANDERS.some(l => l.id === q.get('l'))) { S.landerId = q.get('l'); $('m-lander').value = S.landerId; }
    const f = (q.get('f') || '').split('_'); if (f.length >= 2) { $('m-array').value = ['flat', 'track', 'vert'][+f[0]] || 'track'; $('m-dte').checked = f[1] !== '0'; if (f.length > 2) $('m-dsn').checked = f[2] !== '0'; }
    const x = (q.get('x') || 'none_3_0').split('_'), kinds = ['none', 'array', 'load', 'battery', 'antenna', 'custom'];
    $('m-fault').value = kinds.includes(x[0]) ? x[0] : 'none'; $('m-fday').value = isFinite(parseFloat(x[1])) ? x[1] : 3; $('m-safe').checked = x[2] === '1'; $('m-strict').checked = q.get('s') === '1'; $('m-heat').checked = q.get('h') === '1';
    if (x[0] === 'custom' && x.length >= 7) ['c-arr', 'c-load', 'c-bat', 'c-out'].forEach((id, i) => { if (isFinite(parseFloat(x[3 + i]))) $(id).value = x[3 + i]; });
    readCfg();
    const eye = parseFloat(q.get('mast')); if (isFinite(eye)) { S.eye = Math.max(0, Math.min(100, eye)); $('eye').value = S.eye; }
    if (q.has('cmp')) S.cmp = q.get('cmp').split('_').filter(id => SITES.some(s => s.id === id)).slice(0, 4);
    const la = parseFloat(q.get('lat')), lo = parseFloat(q.get('lon')), sid = q.get('site');
    if (isFinite(la) && isFinite(lo)) { const lat = Math.max(-90, Math.min(90, la)), lon = ((lo + 180) % 360 + 360) % 360 - 180; S.custom = { id: 'custom', g: 'Custom', name: 'Custom ' + fmtLat(lat) + ' ' + fmtLon(lon), lat, lon, note: 'Custom coordinates.' }; S.site = S.custom; }
    else if (sid && SITES.some(s => s.id === sid)) S.site = byId(sid);
    VW.az = null; S.mapTab = S.site.lat <= CAP ? 'pole' : 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon;
    const t = Date.parse((q.get('t') || '') + ':00Z'); if (isFinite(t) && t > Date.UTC(1950, 0, 1) && t < Date.UTC(2099, 0, 1)) { S.t = t; S.anchor = floorDay(t); S.calAnchor = S.anchor; }
    S.plan = { site: S.site, t: floorHour(S.t) };
    return true;
  }
  function setView(v) { S.view = VIEWS.includes(v) ? v : 'plan'; syncInputs(); render(); try { if (hashView() !== S.view || location.hash.includes('?')) history.replaceState(null, '', '#' + S.view); } catch (_) {} }
  // ---------- lander picker ----------
  const PATHN = { 'power.array.faces': 'solar output', 'power.array.peak_w': 'solar output', 'power.battery.capacity_wh': 'battery', 'power.loads.sunlit_w': 'load in sunlight',
                  'power.loads.dark_w': 'load in darkness', 'comms.antenna_height_m': 'mast height', 'landing.accuracy_m_3sigma': 'landing accuracy', 'landing.max_slope_deg': 'safe slope' };
  function fillLanders() {
    const real = LANDERS.filter(l => !l.illustrative), gen = LANDERS.filter(l => l.illustrative), o = l => '<option value="' + l.id + '">' + l.name + '</option>';
    $('m-lander').innerHTML = '<optgroup label="Real landers">' + real.map(o).join('') + '</optgroup><optgroup label="Generic">' + gen.map(o).join('') + '</optgroup>';
    $('m-lander').value = S.landerId;
  }
  function applyLander(id) {
    const p = presetOf(id); if (!p) return;
    S.landerId = id; S.landerEdited = false; const a = p.power.array;
    $('m-array').value = a.type === 'tracking' ? 'track' : a.type === 'vertical' ? 'vert' : 'flat';
    $('m-peak').value = Math.round(a.type === 'vertical' ? a.faces.reduce((s, f) => s + f.peak_w, 0) : a.peak_w);
    $('m-cap').value = p.power.battery.capacity_wh; $('m-res').value = Math.round(p.power.battery.min_soc * 100);
    $('m-lsun').value = p.power.loads.sunlit_w; $('m-ldark').value = p.power.loads.dark_w; $('m-safe').checked = !!p.power.safe_mode;
    S.eye = p.comms.antenna_height_m; $('eye').value = S.eye;
    S.acc = Math.max(200, Math.min(5000, p.landing.accuracy_m_3sigma)); $('k-acc').value = S.acc; $('k-slope').value = p.landing.max_slope_deg;
    S.sig.slope = p.landing.max_slope_deg;
    readCfg();
  }
  function drawLanderSpec() {
    const p = presetOf(S.landerId), el = $('m-lspec'); if (!el) return;
    if (!p) { el.innerHTML = ''; return; }
    const as = k => (p.assumed || []).includes(k) ? ' <span class="as">(assumed)</span>' : '', a = p.power.array;
    const tot = a.type === 'vertical' ? a.faces.reduce((s, f) => s + f.peak_w, 0) : a.peak_w;
    const rowsH = [
      ['Solar output', Math.round(tot) + ' W, ' + (a.type === 'vertical' ? a.faces.length + ' side panels' : a.type === 'tracking' ? 'sun-tracking' : 'flat on top') + as('power.array.faces') + as('power.array.peak_w')],
      ['Battery', fmtWh(p.power.battery.capacity_wh) + as('power.battery.capacity_wh')],
      ['Load, sunlight / dark', p.power.loads.sunlit_w + ' W / ' + p.power.loads.dark_w + ' W' + as('power.loads.sunlit_w')],
      ['Mast (antenna height)', p.comms.antenna_height_m + ' m' + as('comms.antenna_height_m')],
      ['Landing accuracy (3σ)', p.landing.accuracy_m_3sigma + ' m' + as('landing.accuracy_m_3sigma')],
      ['Safe slope', p.landing.max_slope_deg + '°' + as('landing.max_slope_deg')]];
    el.innerHTML = (p.operator ? '<div><b>' + p.name + '</b> · ' + p.operator + '</div>' : '<div><b>' + p.name + '</b></div>') + (p.status ? '<div class="lsrc">' + p.status + '</div>' : '')
      + '<table>' + rowsH.map(x => '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td></tr>').join('') + '</table>'
      + (p.facts && p.facts.length ? '<ul>' + p.facts.map(f => '<li>' + f + '</li>').join('') + '</ul>' : '')
      + '<div class="lsrc">' + p.source + '</div>'
      + (S.landerEdited ? '<div class="mod">You have changed some numbers, so the results below are for an edited version of this lander.</div>' : '');
  }
  function readCfg() {
    const num = (id, lo, hi, def) => { const v = parseFloat($(id).value); const r = isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; $(id).value = r; return r; };
    const c = S.cfg; c.days = Math.round(num('m-days', 1, 60, 10)); c.peakW = num('m-peak', 0, 1e5, 400); c.arrayType = $('m-array').value; c.loadSun = num('m-lsun', 0, 1e5, 180); c.loadDark = num('m-ldark', 0, 1e5, 60);
    c.capWh = num('m-cap', 1, 1e6, 2000); c.minSoc = num('m-res', 0, 90, 20) / 100; c.needEarth = $('m-dte').checked; c.useDsn = $('m-dsn').checked; c.maxGapH = num('m-gap', 0, 2000, 12); c.margin = num('m-margin', 0, 3, 0.3);
    c.autonomyH = num('m-auto', 0, 72, 6);
    const kind = $('m-fault').value;
    c.fault = { kind, day: num('m-fday', 0, 60, 3) };
    if (kind === 'custom') Object.assign(c.fault, { array_loss_pct: num('c-arr', 0, 100, 20), extra_load_w: num('c-load', 0, 10000, 50), battery_loss_pct: num('c-bat', 0, 95, 10), comms_outage_h: num('c-out', 0, 1000, 12) });
    c.safe = $('m-safe').checked; c.strict = $('m-strict').checked; c.heat = $('m-heat').checked; $('m-fday').disabled = kind === 'none'; $('c-custom').hidden = kind !== 'custom'; $('c-why').textContent = FAULTS[kind] || '';
    $('m-gap').disabled = !c.needEarth; $('m-dsn').disabled = !c.needEarth; drawLanderSpec(); render();
  }

  let raf = 0, ready = false;
  function render() {
    if (!ready) return;
    ensureTab();
    { const rg = TER.ringsFor(S.site); TER.rings = rg ? rg.rings : null; }
    S.now = bodyAt(S.t);
    const exact = skyExact(), lerped = stateAt(ser(S.site), S.t);
    if (exact) {
      const sn = exact.sun, ea = exact.earth;
      S.cur = { sunEl: sn.elevation_deg, sunAz: sn.azimuth_deg, sunRad: sn.angular_radius_deg, sunHz: sn.horizon_deg, sunClr: sn.clearance_deg, sunFrac: sn.visible_share,
                earthEl: ea.elevation_deg, earthAz: ea.azimuth_deg, earthRad: ea.angular_radius_deg, earthHz: ea.horizon_deg, earthClr: ea.clearance_deg, h0: exact.heights.ground_m, irr: sn.irradiance_factor };
      S.now = { sun: exact.vectors_km.sun, earth: exact.vectors_km.earth };
      S.ev = { sun: evOf(sn.above_horizon ? sn.next_sunset : sn.next_sunrise), earth: evOf(ea.above_horizon ? ea.next_earthset : ea.next_earthrise) }; S.evAt = S.t; S.dsn = exact.dsn;
    } else {
      S.cur = lerped;
      if (S.ev && S.evAt !== S.t) { const keep = ev => ev && ev.t > S.t ? ev : null; S.ev = { sun: keep(S.ev.sun), earth: keep(S.ev.earth) }; }
    }
    drawSiteInfo();
    if (S.cur) drawStatus();
    if (S.view === 'plan') { drawMission(); drawLab(); drawRescue(); drawRisk(); }
    else if (S.view === 'explore') { $('surf').closest('section').hidden = !riskOk(); if (S.cur) { drawSurface(); drawSky(); } else { waiting($('surf'), 'Loading the sky…'); waiting($('sky'), 'Loading the sky…'); } drawTimeline(); drawMap(); }
    else if (S.view === 'learn') drawLearn();
    else if (S.view === 'compare') { drawCmpSky(); drawCompare(); drawCalendar(); }
    if (srv.lastErr && !$('srverr')) { const p = document.createElement('p'); p.id = 'srverr'; p.className = 'tag'; p.style.color = 'var(--bad)'; p.textContent = 'Some data could not be loaded from the server: ' + srv.lastErr.message + '.'; $('siteinfo').after(p); }
  }
  function renderSoon() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  // ---------- events ----------
  $('site').addEventListener('change', e => pickSite(e.target.value));
  $('usecoord').addEventListener('click', () => { const la = parseFloat($('lat').value), lo = parseFloat($('lon').value); if (isFinite(la) && isFinite(lo)) setCustom(la, lo); });
  $('eye').addEventListener('change', e => { const v = parseFloat(e.target.value); S.eye = isFinite(v) ? Math.max(0, Math.min(100, v)) : 2; e.target.value = S.eye; S.landerEdited = true; drawLanderSpec(); render(); });
  $('when').addEventListener('change', e => { const t = Date.parse(e.target.value + ':00Z'); if (isFinite(t)) setTime(t, true); });
  $('bnow').addEventListener('click', () => setTime(Math.round(Date.now() / 60000) * 60000, true));
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => setTime(S.t + (+b.dataset.step) * HOUR, false)));
  document.querySelectorAll('[data-span]').forEach(b => b.addEventListener('click', () => { S.span = +b.dataset.span; if (S.t > S.anchor + S.span * DAY) S.anchor = floorDay(S.t); syncInputs(); render(); }));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  window.addEventListener('hashchange', () => { if (location.hash.includes('?') && applyLink()) { fillSelects(); syncInputs(); render(); return; } const v = hashView(); if (v && v !== S.view) setView(v); });
  ['m-days', 'm-peak', 'm-array', 'm-lsun', 'm-ldark', 'm-cap', 'm-res', 'm-dte', 'm-dsn', 'm-gap', 'm-margin', 'm-auto', 'm-fault', 'm-fday', 'm-safe', 'm-strict', 'm-heat', 'c-arr', 'c-load', 'c-bat', 'c-out'].forEach(id => $(id).addEventListener('change', readCfg));
  ['m-peak', 'm-array', 'm-lsun', 'm-ldark', 'm-cap', 'm-res'].forEach(id => $(id).addEventListener('change', () => { S.landerEdited = true; drawLanderSpec(); }));
  $('m-lander').addEventListener('change', e => applyLander(e.target.value));
  $('s-sun').addEventListener('click', () => { if (S.cur) { VW.az = S.cur.sunAz; drawSurface(); } });
  $('s-earth').addEventListener('click', () => { if (S.cur) { VW.az = S.cur.earthAz; drawSurface(); } });
  $('s-zoom').addEventListener('click', () => { VW.fov = VW.fov === 75 ? 40 : VW.fov === 40 ? 20 : 75; drawSurface(); });
  (() => { const cv = $('surf'); let px = null, az0 = 0, pend = 0;
    cv.addEventListener('pointerdown', e => { px = e.clientX; az0 = VW.az; VW.drag = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener('pointermove', e => { if (px === null || VW.az === null) return; VW.az = az0 - (e.clientX - px) / cv.clientWidth * VW.fov; if (!pend) pend = requestAnimationFrame(() => { pend = 0; drawSurface(); }); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { if (px !== null) { px = null; VW.drag = false; drawSurface(); } })); })();
  $('d-hard').addEventListener('click', () => setHardware(100, 500));
  $('d-cb-go').addEventListener('click', () => { if (LAB.cb !== null) setHardware(null, LAB.cb); });
  $('d-pa-go').addEventListener('click', () => { if (LAB.pa !== null) setHardware(LAB.pa, null); });
  $('dfront').addEventListener('click', e => { const q = LAB.geo; if (!q) return; const r = $('dfront').getBoundingClientRect(), fx = (e.clientX - r.left - q.L) / q.pw, fy = 1 - (e.clientY - r.top - q.T) / q.ph; if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return; setHardware(Math.round(Math.exp(q.y0 + fy * (q.y1 - q.y0)) / 5) * 5, Math.round(Math.exp(q.x0 + fx * (q.x1 - q.x0)) / 10) * 10); });
  $('datlas').addEventListener('click', e => { const q = LAB.ageo, A = LAB.atlas; if (!q || !A) return; const r = $('datlas').getBoundingClientRect(), j = Math.max(0, Math.min(q.NA - 1, Math.floor((e.clientX - r.left - q.L) / q.pw * q.NA))); setTime(A.t0 + j * A.step, false); });
  $('d-tbl').addEventListener('click', e => { const b = e.target.closest('[data-ai]'), A = LAB.atlas; if (!b || !A) return; setTime(A.t0 + (+b.dataset.ai) * A.step, false); });
  $('k-acc').addEventListener('change', e => { const v = parseFloat(e.target.value); S.acc = isFinite(v) ? Math.max(200, Math.min(5000, v)) : 1000; e.target.value = S.acc; render(); });
  $('k-time').addEventListener('change', e => { const v = parseFloat(e.target.value); S.tjit = isFinite(v) ? Math.max(0, Math.min(72, v)) : 6; e.target.value = S.tjit; render(); });
  const sigIn = () => { const num = (id, lo, hi, def) => { const v = parseFloat($(id).value), r = isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; $(id).value = r; return r; };
    S.sig = { power: num('k-sp', 0, 50, 5), load: num('k-sl', 0, 50, 5), cap: num('k-sb', 0, 50, 3), terrain: num('k-st', 0, 2, 0.15), slope: num('k-slope', 1, 45, 12), corr: $('k-corr').checked, seed: Math.round(num('k-seed', 1, 2e9, 20261114)) }; render(); };
  const LEVELS = { low: { 'k-time': 2, 'k-sp': 3, 'k-sl': 3, 'k-sb': 2, 'k-st': 0.1 }, typical: { 'k-time': 6, 'k-sp': 5, 'k-sl': 5, 'k-sb': 3, 'k-st': 0.15 }, high: { 'k-time': 12, 'k-sp': 10, 'k-sl': 10, 'k-sb': 6, 'k-st': 0.3 } };
  $('k-level').addEventListener('change', e => { const L = LEVELS[e.target.value]; if (!L) return; for (const id in L) $(id).value = L[id]; S.tjit = L['k-time']; sigIn(); });
  ['k-sp', 'k-sl', 'k-sb', 'k-st', 'k-time'].forEach(id => $(id).addEventListener('change', () => { $('k-level').value = 'custom'; }));
  ['k-sp', 'k-sl', 'k-sb', 'k-st', 'k-slope', 'k-corr', 'k-seed'].forEach(id => $(id).addEventListener('change', sigIn));
  $('k-new').addEventListener('click', () => { $('k-seed').value = 1 + Math.floor(Math.random() * 1.9e9); sigIn(); });
  $('k-go').addEventListener('click', () => { const r = riskNow(); if (r && !r.pending && !r.stale) setCustom(r.best.lat, r.best.lon); });
  $('risk').addEventListener('click', e => { const r = riskNow(); if (!r || r.pending || r.stale) return; const b = $('risk').getBoundingClientRect(), ix = Math.max(0, Math.min(r.n - 1, Math.floor((e.clientX - b.left) / b.width * r.n))), iy = Math.max(0, Math.min(r.n - 1, Math.floor((e.clientY - b.top) / b.width * r.n))); setCustom(r.lat[iy * r.n + ix], r.lon[iy * r.n + ix]); });
  $('r-slip').addEventListener('input', e => { S.slip = +e.target.value; drawRescue(); });
  $('r-flex').addEventListener('change', e => { const v = parseFloat(e.target.value); S.flex = isFinite(v) ? Math.max(0, Math.min(60, Math.round(v))) : 10; e.target.value = S.flex; drawRescue(); });
  $('r-scope').addEventListener('change', e => { S.scope = e.target.value; drawRescue(); });
  $('r-set').addEventListener('click', () => { S.plan = { site: S.site, t: floorHour(S.t) }; drawRescue(); });
  $('r-tbl').addEventListener('click', e => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    const t = +b.dataset.t; S.t = t; if (S.t < S.anchor || S.t > S.anchor + S.span * DAY) S.anchor = floorDay(S.t);
    if (b.dataset.open) pickSite(b.dataset.open); else setCustom(+b.dataset.lat, +b.dataset.lon);
    document.querySelector('[aria-label="Mission verdict"]').scrollIntoView({ block: 'nearest' });
  });
  let last = 0, lastDraw = 0;
  function tick(ts) {
    if (!S.playing) return; const dt = Math.min(200, ts - (last || ts)); last = ts; S.t += dt * 86400;
    if (ts - lastDraw > 70) { lastDraw = ts; setTime(S.t, false); }
    requestAnimationFrame(tick);
  }
  $('play').addEventListener('click', () => { S.playing = !S.playing; $('play').textContent = S.playing ? 'Pause' : 'Play'; last = 0; if (S.playing) requestAnimationFrame(tick); else setTime(Math.round(S.t / 60000) * 60000, false); });
  const scrubTo = t => { S.t = Math.round(t / 60000) * 60000; syncInputs(); renderSoon(); };
  scrub($('tl'), TLP, scrubTo); scrub($('cmp'), CMPP, scrubTo);
  $('cal').addEventListener('pointermove', e => { const d = calDayAt(e); if (d !== calHover) { calHover = d; drawCalendar(); } });
  $('cal').addEventListener('pointerleave', () => { calHover = null; drawCalendar(); });
  $('cal').addEventListener('click', e => { const d = calDayAt(e); if (d === null) return; calHover = null; S.t = S.calAnchor + d * DAY; S.anchor = floorDay(S.t); syncInputs(); render(); });
  $('chips').addEventListener('click', e => { const id = e.target.dataset && e.target.dataset.rm; if (id) { S.cmp = S.cmp.filter(x => x !== id); fillSelects(); render(); } });
  $('addcmp').addEventListener('change', e => { const id = e.target.value; if (id && !S.cmp.includes(id)) { S.cmp.push(id); if (S.cmp.length > 4) S.cmp.shift(); } fillSelects(); render(); });
  $('m-pole').addEventListener('click', () => { S.mapTab = 'pole'; drawMap(); }); $('m-globe').addEventListener('click', () => { S.mapTab = 'globe'; GL.lat = Math.max(-62, Math.min(62, S.site.lat)); GL.lon = S.site.lon; drawMap(); }); $('m-flat').addEventListener('click', () => { S.mapTab = 'flat'; drawMap(); });
  (() => { const cv = $('map'); let p0 = null, pend = 0;
    cv.addEventListener('pointerdown', e => { if (S.mapTab !== 'globe') return; p0 = { x: e.clientX, y: e.clientY, lat: GL.lat, lon: GL.lon }; GL.moved = false; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener('pointermove', e => { if (!p0 || !mapGeom || !mapGeom.globe) return; const dx = e.clientX - p0.x, dy = e.clientY - p0.y; if (!GL.moved && Math.hypot(dx, dy) < 5) return; GL.moved = true; GL.drag = true;
      GL.lon = p0.lon - dx / mapGeom.R * R2D; GL.lat = Math.max(-90, Math.min(90, p0.lat + dy / mapGeom.R * R2D)); if (!pend) pend = requestAnimationFrame(() => { pend = 0; drawMap(); }); });
    ['pointerup', 'pointercancel'].forEach(n => cv.addEventListener(n, () => { if (!p0) return; p0 = null; if (GL.drag) { GL.drag = false; drawMap(); } })); })();
  $('l-sun').addEventListener('click', () => { S.layer = 'sun'; drawMap(); }); $('l-earth').addEventListener('click', () => { S.layer = 'earth'; drawMap(); });
  function copy(text, msgEl, okMsg) {
    const done = ok => { $(msgEl).textContent = ok ? okMsg : 'The browser blocked the copy. Open the page in its own tab and try again.'; };
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch (_) { done(false); }
  }
  // the hourly series for the window on screen, as CSV (server: /windows?format=csv)
  const csvURL = () => API + '/windows?' + qs({ ...loc(S.site), start: iso(S.anchor), end: iso(S.anchor + S.span * DAY), array_height_m: S.eye, antenna_height_m: S.eye, format: 'csv' });
  async function csvText() { const r = await fetch(csvURL()); if (!r.ok) throw new Error('the server answered ' + r.status); return r.text(); }
  function download(name, text, type) {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileStem = () => 'mons-carlo-' + (S.site.id === 'custom' ? 'custom' : S.site.id) + '-' + new Date(S.t).toISOString().slice(0, 10);
  $('csv').addEventListener('click', async () => { try { const t = await csvText(); copy(t, 'csvmsg', 'Copied ' + (t.trim().split('\n').length - 1) + ' rows for ' + S.site.name + '.'); } catch (err) { $('csvmsg').textContent = 'Could not get the data: ' + err.message; } });
  $('csvdl').addEventListener('click', async () => { try { const t = await csvText(); download(fileStem() + '.csv', t, 'text/csv'); $('csvmsg').textContent = 'Saved ' + (t.trim().split('\n').length - 1) + ' rows for ' + S.site.name + '.'; } catch (err) { $('csvmsg').textContent = 'Could not get the data: ' + err.message; } });
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
    { v: 'explore', sel: '#glance', t: 'The same sky as numbers along the top: how far the Sun and Earth sit above the hills, how long until each one sets, how much power the lander gets right now, and how many of the next 24 hours it can reach Earth through the Deep Space Network.' },
    { v: 'compare', sel: '[aria-label="Compare sites"]', t: 'Put sites side by side. Each strip is one site at the same instant, and the bars underneath show when each has the Sun, the Earth, or both. The calendar further down marks the landing days that work at each site over a whole year.' },
    { v: 'plan', sel: '[aria-label="Mission needs"]', t: 'Pick a lander, such as ispace\'s HAKUTO-R or Intuitive Machines\' Nova-C, or type your own numbers. The server runs the battery and the radio link hour by hour and says whether the mission makes it.' },
    { v: 'plan', sel: '[aria-label="Mission design"]', t: 'This lander is too small: 100 W of solar and a 500 Wh battery. The green area is every solar and battery size that gets through. The two tiles say how big the battery would need to be with these panels, or how much solar with this battery, and the chart underneath does the same for other landing dates.',
      go: () => { tourKeep.hw = [S.cfg.peakW, S.cfg.capWh]; setHardware(100, 500); }, leave: () => setHardware(tourKeep.hw[0], tourKeep.hw[1]) },
    { v: 'plan', sel: '[aria-label="Contingency planning"]', t: 'Now plan for something going wrong. At Malapert Massif an unexpected 100 W load appears on mission day 3. Without safe mode the battery runs flat. With it, the lander survives.',
      go: () => { tourKeep.site = S.site.id; tourKeep.t2 = S.t; $('m-fault').value = 'load'; $('m-fday').value = 3; $('m-safe').checked = true; readCfg(); pickSite('mala'); setTime(Date.UTC(2026, 11, 23), true); },
      leave: () => { $('m-fault').value = 'none'; $('m-safe').checked = false; readCfg(); pickSite(tourKeep.site); setTime(tourKeep.t2, true); } },
    { v: 'plan', sel: '[aria-label="Landing risk"]', t: 'Landers miss their target by hundreds of metres. Thousands of simulated landings give a chance of success, show what goes wrong, and check whether aiming a little to one side is safer.' },
    { v: 'plan', sel: '[aria-label="Launch slip"]', t: 'Last, say the launch slips by 14 days. The table lists the sites and landing times that still work. Move the slider to try other delays.' },
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
  // first-visit introduction: hidden for good once dismissed
  let introSeen = false; try { introSeen = localStorage.getItem('ls-intro') === 'hidden'; } catch (_) {}
  $('intro').hidden = introSeen;
  const hideIntro = () => { $('intro').hidden = true; try { localStorage.setItem('ls-intro', 'hidden'); } catch (_) {} };
  $('intro-x').addEventListener('click', hideIntro);
  document.querySelectorAll('[data-intro]').forEach(b => b.addEventListener('click', () => {
    const go = b.dataset.intro; hideIntro();
    if (go === 'tour') tourShow(0); else if (go === 'compare') { S.cmp = ['mala', 'ridge', 'gerl']; pickSite('shack'); setView('compare'); } else setView(go);
    window.scrollTo(0, 0);
  }));
  try { const th = localStorage.getItem('ls-theme'); if (th) document.documentElement.dataset.theme = th; } catch (_) {}
  $('theme').addEventListener('click', () => { const th = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = th; try { localStorage.setItem('ls-theme', th); } catch (_) {} });
  $('tour-x').addEventListener('click', () => tourShow(tourI + 1));
  $('tour-b').addEventListener('click', () => tourShow(tourI - 1));
  $('tour-c').addEventListener('click', () => tourShow(-1));

  // ---------- sticky header heights (the plan sub-navigation and anchor jumps sit below them) ----------
  {
    const hdr = document.querySelector('.appbar'), bar = $('ctlbar'), root = document.documentElement.style;
    const measure = () => {
      const hh = getComputedStyle(hdr).position === 'sticky' ? hdr.offsetHeight : 0;
      root.setProperty('--hdr-h', hh + 'px'); root.setProperty('--stick-h', (hh + bar.offsetHeight) + 'px');
    };
    if (window.ResizeObserver) { const ro = new ResizeObserver(measure); ro.observe(hdr); ro.observe(bar); }
    window.addEventListener('resize', measure); measure();
  }
  const reTheme = () => { readTheme(); if (ready) render(); };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reTheme); } catch (_) {}
  new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let rw = 0; new ResizeObserver(() => { const w = document.body.clientWidth; if (w !== rw && ready) { rw = w; renderSoon(); } }).observe(document.body);

  // ---------- boot ----------
  try {
    readTheme();
    document.querySelectorAll('a[href="docs"]').forEach(a => { a.href = (API || '') + '/docs'; });
    const sj = await getJSON('/sites');
    SITES = sj.sites.map(s => ({ id: s.id, g: s.group, name: s.name, lat: s.lat, lon: s.lon, note: s.note }));
    S.site = byId('ridge') || SITES[0];
    try { LANDERS = (await getJSON('/landers?full=true')).landers.filter(l => l.kind === 'preset'); } catch (_) { LANDERS = []; }
    fillLanders(); readCfg();
    $('boot').querySelector('p').textContent = 'Loading the polar terrain and the ephemeris from the server…';
    texImg = new Image(); texImg.onload = () => { try { const c = document.createElement('canvas'); c.width = texImg.naturalWidth; c.height = texImg.naturalHeight; const cg = c.getContext('2d'); cg.drawImage(texImg, 0, 0); const d = cg.getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height); for (let i = 0; i < a.length; i++) a[i] = d[i * 4]; GL.tex = a; GL.tw = c.width; GL.th = c.height; } catch (_) {} if (ready && S.mapTab !== 'pole') drawMap(); };
    texImg.src = API + '/terrain/moon.jpg';
    TER.loadPolar().then(() => { buildPolar(); renderSoon(); }, err => { srv.lastErr = err; renderSoon(); });
    const hv = hashView(); if (VIEWS.includes(hv)) S.view = hv;
    ensureTab();
    // default plan: the last landing day of the first run of days at the default site that meet the needs. The mission then
    // runs up to the end of the window, so the page opens on a plan that passes with little to spare and not on the easiest day.
    try {
      const cal = await getJSON('/calendar', { locations: [loc(S.site)], start: iso(S.calAnchor), days: 120, lander: lander(), mission: missionSpec() });
      const st = cal.sites[0].state; let d0 = 0; for (let d = 0; d < 120; d++) if (st[d] === 2) { let e = d; while (e + 1 < st.length && st[e + 1] === 2) e++; d0 = e; break; }
      S.t = S.calAnchor + d0 * DAY;
    } catch (_) {}
    S.plan = { site: S.site, t: floorHour(S.t) }; S.anchor = floorDay(S.t); if (S.anchor < S.calAnchor) S.calAnchor = S.anchor;
    applyLink();
    $('boot').remove(); $('app').hidden = false; ready = true;
    fillSelects(); syncInputs();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderSoon());
    render();
    window.__ready = true;
  } catch (err) {
    $('boot').innerHTML = '<p>The Mons Carlo API could not be reached at <code>' + (API || location.origin) + '</code> (' + (err && err.message ? err.message : err) + '). Start it with <code>python run.py</code> in the <code>backend</code> folder, or set its address in <code>web/config.js</code>, then reload.</p>';
    throw err;
  }
})();
