/* Terrain for drawing: the 400 m polar raster and the height rings around a site, both served by the API, sampled
   bilinearly or bicubically. Used by the surface view, the shadow map and the landing-risk relief. */
export function createTerrain({ api, need, qs }) {
  // Height rings around the site (server: /terrain/rings): 10 m within 1.5 km, 40 m within 6 km, 160 m within 30 km,
  // then the 400 m polar raster (server: /terrain/polar400). Map coordinates are south polar stereographic, in km.
  const TER = {
    polar: null, rings: null,
    ready: () => !!TER.polar,
    // both terrain files arrive row-delta coded: each value is the change from the previous one in its row
    undelta: (a, n) => { for (let r = 0; r < n; r++) { let acc = 0; for (let c = 0, i = r * n; c < n; c++, i++) { acc = (acc + a[i]) << 16 >> 16; a[i] = acc; } } return a; },
    loadPolar: async () => { const r = await api('/terrain/polar400'), n = +r.headers.get('X-Size'), buf = await r.arrayBuffer(); TER.polar = { n, km: 0.4, half: n * 0.2, a: TER.undelta(new Int16Array(buf), n) }; },
    ringsFor(site) {
      if (site.lat > -79.9) return null;
      const key = 'rings|' + site.lat.toFixed(5) + ',' + site.lon.toFixed(5);
      return need(key, async () => {
        const r = await api('/terrain/rings?' + qs({ lat: site.lat, lon: site.lon })), buf = await r.arrayBuffer(), dv = new DataView(buf);
        let o = 0; const count = dv.getUint32(o, true); o += 4; const rings = [];
        for (let k = 0; k < count; k++) {
          const n = dv.getUint32(o, true), cell = dv.getFloat32(o + 4, true) / 1000, x0 = dv.getFloat64(o + 8, true) / 1000, y0 = dv.getFloat64(o + 16, true) / 1000, base = dv.getFloat32(o + 24, true), sc = dv.getFloat32(o + 28, true);
          o += 32; const q = TER.undelta(new Int16Array(buf.slice(o, o + n * n * 2)), n), a = new Float32Array(n * n); o += n * n * 2;
          for (let i = 0; i < a.length; i++) a[i] = base + q[i] * sc;
          rings.push({ n, km: cell, x: x0, y: y0, a, half: (n - 1) / 2 * cell, cx: x0 + (n - 1) / 2 * cell, cy: y0 - (n - 1) / 2 * cell });
        }
        return { rings, tier: r.headers.get('X-Tier') };
      });
    },
    // bicubic (Catmull-Rom) sample of one ring; NaN outside it
    cubic(q, x, y) {
      const c = (x - q.x) / q.km, r = (q.y - y) / q.km, c0 = Math.floor(c), r0 = Math.floor(r), n = q.n;
      if (c0 < 1 || r0 < 1 || c0 > n - 3 || r0 > n - 3) return NaN;
      const fc = c - c0, fr = r - r0, a = q.a;
      const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
      let i = (r0 - 1) * n + c0 - 1;
      const v0 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n; const v1 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n;
      const v2 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc); i += n; const v3 = cr(a[i], a[i + 1], a[i + 2], a[i + 3], fc);
      return cr(v0, v1, v2, v3, fr);
    },
    linear(q, x, y) {
      const c = (x - q.x) / q.km, r = (q.y - y) / q.km; if (c < 0 || r < 0 || c > q.n - 1.001 || r > q.n - 1.001) return NaN;
      const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, a = q.a, i = r0 * q.n + c0;
      return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + q.n] * (1 - fc) + a[i + q.n + 1] * fc) * fr;
    },
    polarXY(x, y) {
      const P = TER.polar; let c = (x + P.half) / P.km - 0.5, r = (P.half - y) / P.km - 0.5;
      if (c < 0) c = 0; if (r < 0) r = 0; if (c > P.n - 1.001) c = P.n - 1.001; if (r > P.n - 1.001) r = P.n - 1.001;
      const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, a = P.a, i = r0 * P.n + c0;
      return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) + (a[i + P.n] * (1 - fc) + a[i + P.n + 1] * fc) * fr;
    },
    // height (m) at map point (km): the finest ring that covers it, blended into the next one over the outer 15% of
    // each ring so no seam shows, then the polar raster
    sample(x, y, fine) {
      const R = TER.rings;
      if (R) for (let k = 0; k < R.length; k++) {
        const q = R[k], u = Math.max(Math.abs(x - q.cx), Math.abs(y - q.cy)) / q.half;
        if (u >= 0.97) continue;
        const v = fine ? TER.cubic(q, x, y) : TER.linear(q, x, y); if (v !== v) continue;
        if (u <= 0.82) return v;
        const w = (u - 0.82) / 0.15, nx = k + 1 < R.length ? (fine ? TER.cubic(R[k + 1], x, y) : TER.linear(R[k + 1], x, y)) : TER.polarXY(x, y);
        return nx === nx ? v * (1 - w) + nx * w : v;
      }
      return TER.polarXY(x, y);
    },
    elevXY: (x, y) => TER.sample(x, y, false),
    elevXYsmooth: (x, y) => TER.sample(x, y, true),
    // grid cell size (km) of the terrain at distance d (km) from the site
    resAt: d => d < 1.2 ? 0.01 : d < 4.9 ? 0.04 : d < 24 ? 0.16 : 0.4,
  };

  return TER;
}
