/* Ephemeris + geometry engine. Needs global Astronomy (astronomy-engine). */
const Eng = (() => {
  const A = (typeof Astronomy !== 'undefined') ? Astronomy : require('astronomy-engine');
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, AU = 149597870.7;
  const RM = 1737.4, RSUN = 695700, REARTH = 6378.137;

  // Sun and Earth position vectors (km) in the Moon body-fixed frame at a JS Date / ms.
  function bodyFixed(ms) {
    const t = A.MakeTime(new Date(ms));
    const m = A.GeoMoon(t);                       // geocentric Moon, J2000 equatorial, AU
    const s = A.GeoVector(A.Body.Sun, t, true);   // geocentric Sun, light-time + aberration
    const ax = A.RotationAxis(A.Body.Moon, t);    // IAU lunar pole + prime meridian angle
    const a0 = ax.ra * 15 * D2R, W = ax.spin * D2R;
    const p = [ax.north.x, ax.north.y, ax.north.z];
    const N = [-Math.sin(a0), Math.cos(a0), 0];   // node of lunar equator on J2000 equator
    const M = cross(p, N);
    const cw = Math.cos(W), sw = Math.sin(W);
    const X = [N[0]*cw + M[0]*sw, N[1]*cw + M[1]*sw, N[2]*cw + M[2]*sw];
    const Y = cross(p, X);
    const sv = [(s.x - m.x) * AU, (s.y - m.y) * AU, (s.z - m.z) * AU];
    const ev = [-m.x * AU, -m.y * AU, -m.z * AU];
    return {
      sun: [dot(sv, X), dot(sv, Y), dot(sv, p)],
      earth: [dot(ev, X), dot(ev, Y), dot(ev, p)],
      // Earth-fixed needs for ground-station check are computed separately
    };
  }
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

  // Site basis in the body-fixed frame.
  function siteBasis(lat, lon, h_km) {
    const la = lat * D2R, lo = lon * D2R, cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
    return { up: [cl*co, cl*so, sl], north: [-sl*co, -sl*so, cl], east: [-so, co, 0], r: RM + (h_km || 0) };
  }
  // Topocentric elevation/azimuth (deg) and angular radius (deg) of a body vector seen from the site.
  function look(b, v, radius_km) {
    const x = v[0] - b.r*b.up[0], y = v[1] - b.r*b.up[1], z = v[2] - b.r*b.up[2];
    const d = Math.hypot(x, y, z);
    const u = (x*b.up[0] + y*b.up[1] + z*b.up[2]) / d;
    const n = (x*b.north[0] + y*b.north[1] + z*b.north[2]) / d;
    const e = (x*b.east[0] + y*b.east[1] + z*b.east[2]) / d;
    let az = Math.atan2(e, n) * R2D; if (az < 0) az += 360;
    return { el: Math.asin(Math.max(-1, Math.min(1, u))) * R2D, az, rad: Math.asin(radius_km / d) * R2D, dist: d };
  }
  // Sub-point (lat, lon deg) of a body-fixed vector.
  function subPoint(v) {
    const d = Math.hypot(v[0], v[1], v[2]);
    return { lat: Math.asin(v[2] / d) * R2D, lon: Math.atan2(v[1], v[0]) * R2D };
  }

  // Cached table of body-fixed vectors: Float64Array [sx,sy,sz,ex,ey,ez] per step.
  function makeTable(t0, stepMs, n) {
    const a = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const b = bodyFixed(t0 + i * stepMs);
      a.set(b.sun, i*6); a.set(b.earth, i*6 + 3);
    }
    return { t0, stepMs, n, a };
  }

  // Fraction of a disc (centre elevation el, radius r) above a straight horizon at elevation hz.
  function discFrac(el, r, hz) {
    const d = (el - hz) / r;
    if (d >= 1) return 1; if (d <= -1) return 0;
    return 1 - (Math.acos(d) - d * Math.sqrt(1 - d*d)) / Math.PI;
  }

  // Ground stations (Deep Space Network): elevation of the Moon from each complex.
  const DSN = [
    { name: 'Goldstone', lat: 35.4267, lon: -116.8900 },
    { name: 'Madrid', lat: 40.4314, lon: -4.2481 },
    { name: 'Canberra', lat: -35.4014, lon: 148.9817 },
  ];
  function dsnView(ms) {
    const t = A.MakeTime(new Date(ms));
    return DSN.map(s => {
      const obs = new A.Observer(s.lat, s.lon, 900);
      const eq = A.Equator(A.Body.Moon, t, obs, true, true);
      const h = A.Horizon(t, obs, eq.ra, eq.dec, 'normal');
      return { name: s.name, el: h.altitude };
    });
  }
  return { bodyFixed, siteBasis, look, subPoint, makeTable, discFrac, dsnView, RM, RSUN, REARTH, D2R, R2D };
})();
if (typeof module !== 'undefined') module.exports = Eng;
