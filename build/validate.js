const Eng = require('../src/engine.js');
const T = require('./truth.json');
const stats = T.sites.map(() => ({ se: 0, ee: 0, sa: 0, ea: 0, mse: 0, mee: 0, msa: 0, mea: 0 }));
const t0 = Date.now();
T.rows.forEach((row, i) => {
  const b = Eng.bodyFixed((T.t0 + i * T.step) * 1000);
  T.sites.forEach(([name, lat, lon], k) => {
    const sb = Eng.siteBasis(lat, lon, 0);
    const s = Eng.look(sb, b.sun, Eng.RSUN), e = Eng.look(sb, b.earth, Eng.REARTH);
    const r = row.slice(k*4, k*4+4), st = stats[k];
    const daz = (a, b2, el) => { let d = Math.abs(a - b2); if (d > 180) d = 360 - d; return d * Math.cos(el * Math.PI/180); };
    const d1 = Math.abs(s.el - r[0]), d2 = daz(s.az, r[1], r[0]), d3 = Math.abs(e.el - r[2]), d4 = daz(e.az, r[3], r[2]);
    st.se += d1*d1; st.sa += d2*d2; st.ee += d3*d3; st.ea += d4*d4;
    st.mse = Math.max(st.mse, d1); st.msa = Math.max(st.msa, d2); st.mee = Math.max(st.mee, d3); st.mea = Math.max(st.mea, d4);
  });
});
const n = T.rows.length, ms = Date.now() - t0;
console.log(n + ' epochs x ' + T.sites.length + ' sites, ' + (ms / n * 1000).toFixed(0) + ' us per epoch');
console.log('site     sunEl rms/max      sunAz rms/max      earthEl rms/max    earthAz rms/max  (deg, az on-sky)');
stats.forEach((s, k) => console.log(T.sites[k][0].padEnd(8), [[s.se, s.mse], [s.sa, s.msa], [s.ee, s.mee], [s.ea, s.mea]].map(([q, m]) => (Math.sqrt(q/n).toFixed(4) + '/' + m.toFixed(4)).padEnd(18)).join(' ')));

const worst = Math.max(...stats.map(s => Math.max(s.mse, s.msa, s.mee, s.mea)));
console.log('largest error ' + worst.toFixed(4) + ' deg (limit 0.01)');
if (!(worst < 0.01)) { console.error('FAIL'); process.exit(1); }
