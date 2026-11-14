import numpy as np, gzip, base64, json, io
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
P='/usr/local/lib/python3.13/site-packages/ssa_data_lunar/data/'
d=np.load(P+'moon_dem.npz')['elev_km'].astype(np.float64)*1000.0   # metres, 1440x2880, row0=+90, col0=-180
def enc(a):
    a=np.rint(a).astype(np.int16)
    dl=a.copy(); dl[:,1:]=a[:,1:]-a[:,:-1]            # horizontal delta (wraps in int16)
    u=dl.astype('<i2').view(np.uint8).reshape(-1,2)
    raw=np.concatenate([u[:,0],u[:,1]]).tobytes()     # low-byte plane then high-byte plane
    return base64.b64encode(gzip.compress(raw,9)).decode(), a.shape
g=d.reshape(720,2,1440,2).mean(axis=(1,3))
capS=d[1320:,:].reshape(120,1440,2).mean(axis=2)
capN=d[:120,:].reshape(120,1440,2).mean(axis=2)
out={}
for k,a in (('g',g),('s',capS),('n',capN)):
    b,sh=enc(a); out[k]={'h':sh[0],'w':sh[1],'b64':b}; print(k,sh,len(b)//1024,'KB b64')
im=Image.open(P+'moon.png').convert('L').resize((1440,720),Image.LANCZOS)
buf=io.BytesIO(); im.save(buf,'JPEG',quality=62,optimize=True); out['tex']=base64.b64encode(buf.getvalue()).decode(); print('tex',len(out['tex'])//1024,'KB b64')
im.save('build/tex_preview.jpg',quality=62)
json.dump(out,open('build/data.json','w'))
# sanity: elevation at named points (bilinear on 1/8 grid)
def samp(lat,lon):
    r=(90-lat)*8-0.5; c=((lon+180)%360)*8-0.5
    r0=int(np.clip(np.floor(r),0,1438)); c0=int(np.floor(c)); fr=np.clip(r-r0,0,1); fc=c-c0
    v=lambda rr,cc: d[rr,cc%2880]
    return (v(r0,c0)*(1-fc)+v(r0,c0+1)*fc)*(1-fr)+(v(r0+1,c0)*(1-fc)+v(r0+1,c0+1)*fc)*fr
for n,la,lo in [('S pole',-90,0),('Shackleton rim',-89.78,-155.73),('Connecting ridge',-89.45,-137.31),('de Gerlache rim',-88.71,-68.1),('Malapert',-86.0,2.7),('VIPER Mons Mouton',-85.42,31.62),('IM-2',-84.7906,29.1957),('CE-7 target',-88.8,123.4),('Shackleton floor',-89.67,129.2),('Apollo 11',0.6741,23.473),('Apollo 15',26.1322,3.6339),('Apollo 17',20.1908,30.7717)]:
    print(f'{n:20s} {samp(la,lo):8.0f} m')
