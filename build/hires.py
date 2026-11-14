# High-resolution south-pole terrain: NASA PGDA LDEM_80S_80MPP_ADJ.TIF (LOLA, 80 m/px, MOON_ME/DE421).
# Produces (1) horizon profiles for the curated south-pole sites at full 80 m resolution and
# (2) a 400 m raster for in-browser ray casting of custom points and the live shadow map.
import sys, json, gzip, base64, numpy as np, tifffile
from scipy.ndimage import map_coordinates
TIF = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/Downloads/LDEM_80S_80MPP_ADJ.TIF'
R = 1737400.0; PX = 80.0; HALF = 304000.0
dem = tifffile.imread(TIF).astype(np.float32)
print('dem', dem.shape, 'nan', int(np.isnan(dem).sum()), 'min/max', float(np.nanmin(dem)), float(np.nanmax(dem)))
dem = np.nan_to_num(dem, nan=0.0)
coarse = np.load('/usr/local/lib/python3.13/site-packages/ssa_data_lunar/data/moon_dem.npz')['elev_km'].astype(np.float32) * 1000.0
def coarse_s(lat, lon):
    r = (90 - lat) * 8 - 0.5; c = ((lon + 180) % 360) * 8 - 0.5
    return map_coordinates(coarse, [np.clip(r, 0, 1439), c], order=1, mode='grid-wrap')
def xy(lat, lon):
    rho = 2 * R * np.tan(np.radians(90 + lat) / 2); lo = np.radians(lon)
    return rho * np.sin(lo), rho * np.cos(lo)
def elev(lat, lon):
    x, y = xy(lat, lon); col = (x + HALF) / PX - 0.5; row = (HALF - y) / PX - 0.5
    h = map_coordinates(dem, [row, col], order=1, mode='nearest')
    out = (np.abs(x) > HALF - PX) | (np.abs(y) > HALF - PX)
    if np.any(out): h = np.where(out, coarse_s(lat, lon), h)
    return h
for n, la, lo in [('S pole', -89.9999, 0), ('Shackleton floor', -89.67, 129.2), ('Malapert', -86.0, 2.7), ('IM-2', -84.7906, 29.1957)]:
    print(f'{n:18s} 80m {float(elev(np.array([la]), np.array([lo]))[0]):8.0f}   1/8deg {float(coarse_s(np.array([la]), np.array([lo]))[0]):8.0f}')
def snap(lat, lon, rad=600.0):
    x, y = xy(lat, lon); c0 = int((x + HALF) / PX); r0 = int((HALF - y) / PX); k = int(rad / PX)
    win = dem[r0 - k:r0 + k + 1, c0 - k:c0 + k + 1]; yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    win = np.where(xx * xx + yy * yy <= k * k, win, -1e9); i = np.unravel_index(win.argmax(), win.shape)
    r, c = r0 - k + i[0], c0 - k + i[1]; X = -HALF + (c + 0.5) * PX; Y = HALF - (r + 0.5) * PX; rho = np.hypot(X, Y)
    return float(-90 + 2 * np.degrees(np.arctan(rho / (2 * R)))), float(np.degrees(np.arctan2(X, Y)))
SITES = [('shack', -89.78, -155.73, True), ('ridge', -89.45, -137.31, True), ('gerl', -88.71, -68.10, True), ('ce7', -88.8, 123.4, False),
         ('mala', -86.0, 2.7, True), ('viper', -85.42, 31.62, False), ('im2', -84.7906, 29.1957, False), ('im1', -80.13, 1.44, False), ('pole', -90.0, 0.0, False)]
EYES = [0, 2, 5, 10, 20, 50, 100]; NAZ = 720
d = np.concatenate([np.arange(30, 3000, 30.0), np.arange(3000, 20000, 60.0), 20000 * 1.003 ** np.arange(0, 930)]); d = d[d <= 330000]
az = np.radians(np.arange(NAZ) * 360.0 / NAZ)
out = {'eyes': EYES, 'naz': NAZ, 'sites': {}}
for sid, lat, lon, do_snap in SITES:
    lat0, lon0 = lat, lon
    if do_snap: lat, lon = snap(lat, lon)
    la = np.radians(max(lat, -89.9999)); lo = np.radians(lon)
    h0 = float(elev(np.array([np.degrees(la)]), np.array([lon]))[0])
    th = (d / R)[None, :]; A = az[:, None]
    s2 = np.sin(la) * np.cos(th) + np.cos(la) * np.sin(th) * np.cos(A)
    lat2 = np.degrees(np.arcsin(np.clip(s2, -1, 1)))
    lon2 = np.degrees(lo + np.arctan2(np.sin(A) * np.sin(th) * np.cos(la), np.cos(th) - np.sin(la) * s2))
    h1 = elev(lat2.ravel(), lon2.ravel()).reshape(lat2.shape); r1 = R + h1
    masks = []
    for e in EYES:
        r0 = R + h0 + e
        ang = np.degrees(np.arctan2(r1 * np.cos(th) - r0, r1 * np.sin(th))).max(axis=1)
        masks.append(np.rint(ang * 100).astype(np.int16))
    m = np.stack(masks)
    out['sites'][sid] = {'lat': round(lat, 5), 'lon': round(lon, 5), 'h0': round(h0, 1), 'b64': base64.b64encode(m.astype('<i2').tobytes()).decode()}
    print(f'{sid:6s} ({lat0:.2f},{lon0:.2f}) -> ({lat:.4f},{lon:.4f}) h0 {h0:7.0f} m  mask@2m min/max {m[1].min()/100:.2f}/{m[1].max()/100:.2f}  @10m {m[3].min()/100:.2f}/{m[3].max()/100:.2f}')
# 400 m raster for the browser
F = 5; g = dem.reshape(7600 // F, F, 7600 // F, F).mean(axis=(1, 3)); a = np.rint(g).astype(np.int16)
dl = a.copy(); dl[:, 1:] = a[:, 1:] - a[:, :-1]; u = dl.astype('<i2').view(np.uint8).reshape(-1, 2)
b = base64.b64encode(gzip.compress(np.concatenate([u[:, 0], u[:, 1]]).tobytes(), 9)).decode()
out['p'] = {'n': a.shape[0], 'km': PX * F / 1000.0, 'half': HALF / 1000.0, 'b64': b}
print('400 m raster', a.shape, len(b) // 1024, 'KB b64')
data = json.load(open('build/data.json')); data['hz'] = {'eyes': EYES, 'naz': NAZ, 'sites': out['sites']}; data['p'] = out['p']
json.dump(data, open('build/data.json', 'w')); print('data.json', sum(len(json.dumps(v)) for v in data.values()) // 1024, 'KB')
