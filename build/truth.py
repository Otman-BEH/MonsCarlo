# JPL DE421 + lunar PA orientation (MOON_ME frame) reference values via SPICE
import spiceypy as sp, numpy as np, json, os, lunarsky, skyfield_data
ls=os.path.dirname(lunarsky.__file__); sd=os.path.dirname(skyfield_data.__file__)
for k in [sd+'/data/de421.bsp', ls+'/data/pck/moon_pa_de421_1900-2050.bpc', ls+'/data/fk/satellites/moon_080317.tf']:
    sp.furnsh(k)
R=1737.4
sites=[('pole',-90.0,0.0),('shack',-89.78,-155.73),('im2',-84.7906,29.1957),('a11',0.6741,23.4730),('ce4',-45.4446,177.5991),('c3',-69.3733,32.3191)]
J2000=946728000.0  # unix seconds at 2000-01-01T12:00:00 UTC
def et_of_unix(u): return (u-J2000)+69.184   # TT-UTC = 69.184 s (valid 2017+), TDB~TT
t0=1793491200  # 2026-11-01T00:00Z
out={'sites':sites,'t0':t0,'step':6*3600,'rows':[]}
n=int((2028-2026)*365.25*4+244)
for i in range(n):
    u=t0+i*6*3600; et=et_of_unix(u)
    s,_=sp.spkpos('SUN',et,'MOON_ME','LT+S','MOON'); e,_=sp.spkpos('EARTH',et,'MOON_ME','LT+S','MOON')
    row=[]
    for _,lat,lon in sites:
        la,lo=np.radians(lat),np.radians(lon)
        up=np.array([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)])
        no=np.array([-np.sin(la)*np.cos(lo),-np.sin(la)*np.sin(lo),np.cos(la)]); ea=np.array([-np.sin(lo),np.cos(lo),0])
        for v in (s,e):
            w=v-R*up; w=w/np.linalg.norm(w)
            row+= [float(np.degrees(np.arcsin(w@up))), float(np.degrees(np.arctan2(w@ea,w@no))%360)]
    out['rows'].append(row)
json.dump(out,open('build/truth.json','w'))
print(n,'samples; first row',[round(x,4) for x in out['rows'][0][:8]])
import datetime; print(datetime.datetime.fromtimestamp(t0,datetime.timezone.utc))
