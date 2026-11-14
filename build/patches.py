# Fine terrain patches around each listed south-pole site, cut from NASA's LDEM_80S_80MPP_ADJ.TIF:
#   a: 80 m/px, +-3 km     b: 240 m/px, +-15 km
# Used by the first-person surface view and by the landing-risk analysis. Run after hires.py.
import sys, json, gzip, base64, numpy as np, tifffile
TIF = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/Downloads/LDEM_80S_80MPP_ADJ.TIF'
R = 1737400.0; PX = 80.0; HALF = 304000.0
dem = np.nan_to_num(tifffile.imread(TIF).astype(np.float32), nan=0.0)
data = json.load(open('build/data.json'))
def enc(a):
    a = np.rint(a).astype(np.int16); dl = a.copy(); dl[:, 1:] = a[:, 1:] - a[:, :-1]; u = dl.astype('<i2').view(np.uint8).reshape(-1, 2)
    return base64.b64encode(gzip.compress(np.concatenate([u[:, 0], u[:, 1]]).tobytes(), 9)).decode()
out = {}; tot = 0
for sid, q in data['hz']['sites'].items():
    rho = 2 * R * np.tan(np.radians(90 + max(q['lat'], -89.9999)) / 2); lo = np.radians(q['lon']); x, y = rho * np.sin(lo), rho * np.cos(lo)
    c0 = int((x + HALF) / PX); r0 = int((HALF - y) / PX); rec = {}
    for key, f, half_px in (('a', 1, 38), ('b', 3, 189)):          # half_px in 80 m pixels; b is averaged 3x3
        n = (2 * half_px) // f; r1 = r0 - half_px; c1 = c0 - half_px
        if r1 < 0 or c1 < 0 or r1 + n * f > dem.shape[0] or c1 + n * f > dem.shape[1]: continue    # too close to the map edge
        blk = dem[r1:r1 + n * f, c1:c1 + n * f].reshape(n, f, n, f).mean(axis=(1, 3))
        # map coordinates (km) of the centre of the top-left cell
        rec[key] = {'n': n, 'km': PX * f / 1000, 'x': round((-HALF + c1 * PX + PX * f / 2) / 1000, 5), 'y': round((HALF - r1 * PX - PX * f / 2) / 1000, 5), 'b64': enc(blk)}
        tot += len(rec[key]['b64'])
    out[sid] = rec; print(sid, {k: (v['n'], v['km']) for k, v in rec.items()})
data['patch'] = out; json.dump(data, open('build/data.json', 'w')); print('patches', tot // 1024, 'KB b64')
