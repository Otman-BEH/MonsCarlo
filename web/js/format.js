/* Text formatting for dates, durations, angles and verdicts. */
import { HOUR } from './geo.js';
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const p2 = n => String(n).padStart(2, '0');
export function fmtDate(ms) { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
export function fmtDM(ms) { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
export function fmtDT(ms) { const d = new Date(ms); return fmtDate(ms) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' UTC'; }
export function fmtDur(ms) {
  const h = ms / HOUR;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
  if (h < 48) return Math.floor(h) + ' h ' + p2(Math.round((h - Math.floor(h)) * 60) % 60) + ' min';
  const d = Math.floor(h / 24); return d + ' d ' + Math.round(h - d * 24) + ' h';
}
export const fmtH = h => h >= 48 ? (h / 24).toFixed(1) + ' d' : Math.round(h) + ' h';
export const fmtWh = w => w === null || !isFinite(w) ? 'No size is enough' : w >= 1000 ? (w / 1000).toFixed(w >= 10000 ? 0 : 1) + ' kWh' : Math.round(w) + ' Wh';
export const sg = (v, n) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(n) + '°';
export const fmtLat = v => Math.abs(v).toFixed(2) + '°' + (v < 0 ? 'S' : 'N');
export const fmtLon = v => { let l = ((v + 180) % 360 + 360) % 360 - 180; return Math.abs(l).toFixed(2) + '°' + (l < 0 ? 'W' : 'E'); };
export const compass = az => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
export const STN = ['Fails', 'Marginal', 'Passes'], STL = ['Does not meet the needs', 'Marginal: sensitive to terrain', 'Meets the needs'];
export const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);

