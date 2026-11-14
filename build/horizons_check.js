/* Independent check of the ephemeris engine against NASA/JPL Horizons (live API, no key needed).
   Usage: node build/horizons_check.js
   For each site it asks Horizons for the apparent azimuth and elevation of the Sun and of Earth as seen from
   that point on the Moon (a smooth 1737.4 km sphere, no terrain) and compares them with src/engine.js. */
const Eng = require('../src/engine.js');
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const SITES = [['South pole', -89.99, 0], ['Shackleton rim', -89.78, -155.73], ['IM-2 Athena', -84.7906, 29.1957], ['Apollo 11', 0.6741, 23.473], ["Chang'e 4, far side", -45.4446, 177.5991], ["Chang'e 3", 44.1214, -19.5116]];
const START = '2026-11-01', STOP = '2028-11-01', STEP = '7 d';
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function horizons(body, lat, lon) {
  const q = new URLSearchParams({ format: 'text', COMMAND: `'${body}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'", CENTER: "'coord@301'", COORD_TYPE: "'GEODETIC'",
    SITE_COORD: `'${((lon % 360) + 360) % 360},${lat},0'`, START_TIME: `'${START}'`, STOP_TIME: `'${STOP}'`, STEP_SIZE: `'${STEP}'`, QUANTITIES: "'4'", CSV_FORMAT: "'YES'", ANG_FORMAT: "'DEG'" });
  const res = await fetch(API + '?' + q, { headers: { 'User-Agent': 'lunar-skyline-check' } }), text = await res.text();
  if (!text.includes('$$SOE')) throw new Error('Horizons returned no table: ' + text.slice(-400));
  return text.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n').map(row => {
    const f = row.split(',').map(s => s.trim()), m = /^(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})/.exec(f[0]);
    return { ms: Date.UTC(+m[1], MON[m[2]], +m[3], +m[4], +m[5]), az: +f[3], el: +f[4] };
  });
}

(async () => {
  let worst = 0, n = 0;
  console.log('site                    body    epochs   elevation rms/max (deg)   azimuth on-sky rms/max (deg)');
  for (const [name, lat, lon] of SITES) {
    const b = Eng.siteBasis(lat, lon, 0);
    for (const [label, code, key, radius] of [['Sun', '10', 'sun', Eng.RSUN], ['Earth', '399', 'earth', Eng.REARTH]]) {
      const rows = await horizons(code, lat, lon); await sleep(1000);
      let se = 0, sa = 0, me = 0, ma = 0;
      for (const r of rows) {
        const mine = Eng.look(b, Eng.bodyFixed(r.ms)[key], radius);
        const de = Math.abs(mine.el - r.el), da = Math.abs(((mine.az - r.az + 540) % 360) - 180) * Math.cos(r.el * Math.PI / 180);
        se += de * de; sa += da * da; if (de > me) me = de; if (da > ma) ma = da; n++;
      }
      worst = Math.max(worst, me, ma);
      console.log(name.padEnd(24) + label.padEnd(8) + String(rows.length).padEnd(9) + (Math.sqrt(se / rows.length).toFixed(4) + ' / ' + me.toFixed(4)).padEnd(26) + Math.sqrt(sa / rows.length).toFixed(4) + ' / ' + ma.toFixed(4));
    }
  }
  console.log('\n' + n + ' comparisons, largest difference ' + worst.toFixed(4) + ' deg');
  process.exit(worst < 0.02 ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
