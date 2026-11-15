/* Constants and small geometry used for drawing. The physics lives on the server; these only place things on screen. */
export const DAY = 86400e3, HOUR = 3600e3, D2R = Math.PI / 180, R2D = 180 / Math.PI, RM = 1737.4, SYNODIC = 29.530589;
export function discFrac(el, r, hz) { const d = (el - hz) / r; if (d >= 1) return 1; if (d <= -1) return 0; return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI; }
export function subPoint(v) { const d = Math.hypot(v[0], v[1], v[2]); return { lat: Math.asin(v[2] / d) * R2D, lon: Math.atan2(v[1], v[0]) * R2D }; }
export function maskAt(mask, az) { const n = mask.length, x = (((az % 360) + 360) % 360) * n / 360; const i = Math.floor(x) % n, f = x - Math.floor(x); return mask[i] * (1 - f) + mask[(i + 1) % n] * f; }
export const lerpAz = (a, b, f) => { let d = b - a; if (d > 180) d -= 360; if (d < -180) d += 360; return ((a + d * f) % 360 + 360) % 360; };

export const wrap180 = a => ((a + 540) % 360) - 180;
