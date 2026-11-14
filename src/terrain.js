/* Terrain: LOLA-derived elevation grids, sampling, horizon masks. */
const Terrain = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, RM = 1737.4;
  const grids = {}, profiles = { sites: {}, eyes: [], naz: 0 }, patches = {}; let polar = null, focus = null;
  const CAPLAT = -80.02;
  function unpack(bytes, h, w) {           // two byte planes of row-delta int16 -> Int16Array metres
    const n = h * w, out = new Int16Array(n);
    for (let r = 0; r < h; r++) {
      let acc = 0;
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        let v = bytes[i] | (bytes[n + i] << 8); if (v & 0x8000) v -= 0x10000;
        acc = (c === 0) ? v : ((acc + v + 0x8000) & 0xFFFF) - 0x8000;
        out[i] = acc;
      }
    }
    return out;
  }
  async function gunzipB64(b64) {
    if (typeof DecompressionStream === 'undefined') {          // Node (tests)
      return new Uint8Array(require('zlib').gunzipSync(Buffer.from(b64, 'base64')));
    }
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const st = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  async function load(data) {
    for (const k of ['g', 's', 'n']) {
      const d = data[k];
      grids[k] = { h: d.h, w: d.w, a: unpack(await gunzipB64(d.b64), d.h, d.w) };
    }
    if (data.p) { const d = data.p; polar = { n: d.n, km: d.km, half: d.half, a: unpack(await gunzipB64(d.b64), d.n, d.n) }; }
    if (data.patch) for (const id in data.patch) {
      const o = {}; for (const k of ['a', 'b']) { const d = data.patch[id][k]; if (d) o[k] = { n: d.n, km: d.km, x: d.x, y: d.y, a: unpack(await gunzipB64(d.b64), d.n, d.n) }; }
      patches[id] = o;
    }
    if (data.hz) {
      const dec = (typeof atob === 'undefined') ? b => new Uint8Array(Buffer.from(b, 'base64')) : b => { const t = atob(b), u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
      profiles.eyes = data.hz.eyes; profiles.naz = data.hz.naz;
      for (const id in data.hz.sites) { const q = data.hz.sites[id], u = dec(q.b64); profiles.sites[id] = { lat: q.lat, lon: q.lon, h0: q.h0, a: new Int16Array(u.buffer, u.byteOffset, u.length / 2) }; }
    }
  }
  // 80 m LOLA horizon profile for a curated site, interpolated between precomputed eye heights.
  function profileMask(id, eye_m) {
    const q = profiles.sites[id]; if (!q) return null;
    const ey = profiles.eyes, n = profiles.naz; if (eye_m > ey[ey.length - 1]) return null;
    let k = 0; while (k < ey.length - 2 && eye_m > ey[k + 1]) k++;
    const f = Math.max(0, Math.min(1, (eye_m - ey[k]) / (ey[k + 1] - ey[k]))), mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = (q.a[k * n + i] * (1 - f) + q.a[(k + 1) * n + i] * f) / 100;
    return { mask, h0: q.h0, tier: 'LOLA 80 m' };
  }
  // Fine patches: choose the listed site nearest to (lat, lon); its 80 m and 240 m patches then take priority in elevXY.
  function setFocus(lat, lon) {
    focus = null; if (!polar || lat > -79.9) return null;
    const rho = 2 * RM * Math.tan((90 + lat) / 2 * D2R), x = rho * Math.sin(lon * D2R), y = rho * Math.cos(lon * D2R); let best = 14;
    for (const id in patches) { const q = patches[id].a; if (!q) continue; const d = Math.hypot(q.x + q.n * q.km / 2 - x, q.y - q.n * q.km / 2 - y); if (d < best) { best = d; focus = patches[id]; } }
    return focus;
  }
  function patchAt(q, x, y) {
    const c = (x - q.x) / q.km, r = (q.y - y) / q.km; if (c < 0 || r < 0 || c > q.n - 1.001 || r > q.n - 1.001) return NaN;
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, a = q.a, i = r0 * q.n + c0;
    return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + q.n] * (1 - fc) + a[i + q.n + 1] * fc) * fr;
  }
  // Smooth (Catmull-Rom) sampling of a patch, for drawing: bilinear facets show up as stair-steps on silhouettes.
  function cr(p0, p1, p2, p3, t) { return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))); }
  function patchSmooth(q, x, y) {
    const c = (x - q.x) / q.km, r = (q.y - y) / q.km, c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 1 || r0 < 1 || c0 > q.n - 3 || r0 > q.n - 3) return NaN;
    const fc = c - c0, fr = r - r0, a = q.a, n = q.n; let i = (r0 - 1) * n + c0 - 1;
    const v0 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n; const v1 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n;
    const v2 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n; const v3 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc);
    return cr(v0, v1, v2, v3, fr);
  }
  function elevXYsmooth(x, y) {
    if (focus) { let v = focus.a ? patchSmooth(focus.a, x, y) : NaN; if (v === v) return v; if (focus.b) { v = patchSmooth(focus.b, x, y); if (v === v) return v; } }
    return elevXY(x, y);
  }
  // Terrain height (m) at south-polar map coordinates (km): +y toward the near side, +x toward 90 E.
  function elevXY(x, y) {
    if (focus) { let v = focus.a ? patchAt(focus.a, x, y) : NaN; if (v === v) return v; if (focus.b) { v = patchAt(focus.b, x, y); if (v === v) return v; } }
    const P = polar; let c = (x + P.half) / P.km - 0.5, r = (P.half - y) / P.km - 0.5;
    if (c < 0) c = 0; if (r < 0) r = 0; if (c > P.n - 1.001) c = P.n - 1.001; if (r > P.n - 1.001) r = P.n - 1.001;
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, a = P.a, i = r0 * P.n + c0;
    return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + P.n] * (1 - fc) + a[i + P.n + 1] * fc) * fr;
  }
  function polarElev(lat, lon) {
    const rho = 2 * RM * Math.tan((90 + lat) / 2 * D2R), x = rho * Math.sin(lon * D2R), y = rho * Math.cos(lon * D2R), P = polar;
    if (focus) return elevXY(x, y);
    let c = (x + P.half) / P.km - 0.5, r = (P.half - y) / P.km - 0.5;
    if (c < 0) c = 0; if (r < 0) r = 0; if (c > P.n - 1.001) c = P.n - 1.001; if (r > P.n - 1.001) r = P.n - 1.001;
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, a = P.a, i = r0 * P.n + c0;
    return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + P.n] * (1 - fc) + a[i + P.n + 1] * fc) * fr;
  }
  function bil(g, r, c) {
    let r0 = Math.floor(r); if (r0 < 0) r0 = 0; if (r0 > g.h - 2) r0 = g.h - 2;
    let fr = r - r0; if (fr < 0) fr = 0; if (fr > 1) fr = 1;
    let c0 = Math.floor(c); const fc = c - c0;
    c0 = ((c0 % g.w) + g.w) % g.w; const c1 = (c0 + 1) % g.w;
    const a = g.a, i0 = r0 * g.w, i1 = i0 + g.w;
    return (a[i0 + c0] * (1 - fc) + a[i0 + c1] * fc) * (1 - fr) + (a[i1 + c0] * (1 - fc) + a[i1 + c1] * fc) * fr;
  }
  // Elevation in metres above the 1737.4 km sphere.
  function elev(lat, lon) {
    const c = (((lon + 180) % 360) + 360) % 360 * 4 - 0.5;
    if (polar && lat <= CAPLAT) return polarElev(lat, lon);
    if (lat <= -75.0625) return bil(grids.s, (-75 - lat) * 8 - 0.5, c);
    if (lat >= 75.0625) return bil(grids.n, (90 - lat) * 8 - 0.5, c);
    return bil(grids.g, (90 - lat) * 4 - 0.5, c);
  }
  // Terrain horizon elevation angle (deg) for each whole degree of azimuth, seen from eye height (m).
  function horizonMask(lat, lon, eye_m, naz) {
    naz = naz || 360;
    lat = Math.max(-89.999, Math.min(89.999, lat));
    const h0 = elev(lat, lon), r0 = RM + (h0 + eye_m) / 1000;
    const sl = Math.sin(lat * D2R), cl = Math.cos(lat * D2R);
    const fine = polar && lat < -78.5, ds = [];
    if (fine && focus) { for (let d = 0.04; d < 1; d += 0.04) ds.push(d); for (let d = 1; d < 4; d += 0.1) ds.push(d); for (let d = 4; d < 20; d += 0.4) ds.push(d); for (let d = 20; d <= 320; d *= 1.035) ds.push(d); }
    else if (fine) { for (let d = 0.2; d < 4; d += 0.2) ds.push(d); for (let d = 4; d < 20; d += 0.4) ds.push(d); for (let d = 20; d <= 320; d *= 1.035) ds.push(d); }
    else for (let d = 1; d <= 320; d += Math.max(1, d * 0.04)) ds.push(d);
    const mask = new Float32Array(naz);
    for (let ia = 0; ia < naz; ia++) {
      const az = ia * 360 / naz, ca = Math.cos(az * D2R), sa = Math.sin(az * D2R);
      let best = -90;
      for (let k = 0; k < ds.length; k++) {
        const th = ds[k] / RM, ct = Math.cos(th), st = Math.sin(th);
        const s2 = sl * ct + cl * st * ca;
        const lat2 = Math.asin(s2) * R2D;
        const lon2 = lon + Math.atan2(sa * st * cl, ct - sl * s2) * R2D;
        const r1 = RM + elev(lat2, lon2) / 1000;
        const ang = Math.atan2(r1 * ct - r0, r1 * st) * R2D;
        if (ang > best) best = ang;
      }
      mask[ia] = best;
    }
    return { mask, h0, tier: fine && lat <= CAPLAT ? (focus ? 'LOLA 80 to 400 m' : 'LOLA 400 m') : Math.abs(lat) > 75 ? 'LOLA 3.8 km' : 'LOLA 7.6 km' };
  }
  function maskAt(mask, az) {
    const n = mask.length, x = (((az % 360) + 360) % 360) * n / 360;
    const i = Math.floor(x) % n, f = x - Math.floor(x);
    return mask[i] * (1 - f) + mask[(i + 1) % n] * f;
  }
  return { load, elev, elevXY, elevXYsmooth, setFocus, horizonMask, profileMask, maskAt, grids, profiles, hasPolar: () => !!polar };
})();
if (typeof module !== 'undefined') module.exports = Terrain;
