# Mons Carlo: Lunar Site Navigator

NASA Space Apps Challenge 2026 entry. A lunar south pole landing-site tool: terrain horizon masks, Sun and Earth ephemeris, illumination and Monte Carlo risk analysis for candidate sites.

## Layout

| Folder | Contents |
|---|---|
| `web/` | TypeScript library and tests (`npm install`, `npm test`, `npm run typecheck`). `web/public/data/terrain/` holds the packed terrain layers the app loads at runtime. |
| `pipeline/` | Python scripts that turn the raw data below into the packed terrain files, horizon masks and ephemeris test fixtures (`pip install -r pipeline/requirements.txt`). |
| `docs/` | Technical review of data sources, methods and candidate sites. |
| `data/` | **Not in this repo** (about 1.3 GB, some files over GitHub's 100 MB limit). See below. |

## Running without `data/`

Everything needed to run the web code and its tests is committed: the packed terrain in `web/public/data/terrain/` and the test fixtures in `web/test/fixtures/`. Tests that compare against precomputed horizon masks skip themselves when `data/horizon_masks/` is absent.

```
cd web
npm install
npm test
```

## Data (only needed to re-run `pipeline/`)

Download the files and place them as shown. The scripts look for a `data/` folder next to `pipeline/`.

| Path | What it is | Source |
|---|---|---|
| `data/dem_regional/LDEM_80S_80MPP_ADJ.TIF`, `LDEM_80S_80MPP_ADJ_HILL.TIF` | LOLA south polar digital elevation model, 80 m/pixel from 80°S (and a hillshade) | NASA PDS Geosciences LOLA gridded data records: https://pds-geosciences.wustl.edu/missions/lro/lola.htm |
| `data/dem_regional/LDEM_60S_240MPP_ADJ.TIF` | LOLA DEM, 240 m/pixel from 60°S, used for far-field terrain | same as above |
| `data/dem_sites/*_final_adj_5mpp_surf.tif` | LOLA 5 m/pixel DEMs for named sites (Site01, Site04, Site07, Site11, LM4, LM6, Haworth) | NASA PGDA product 78: https://pgda.gsfc.nasa.gov/products/78 |
| `data/illumination/AVGVISIB_*`, `LPSR_*` | Average Sun and Earth visibility maps and permanently shadowed region map for the south pole (120 m and 60 m, 2016-08), used to cross-check the horizon masks | NASA PGDA product 69, lunar polar illumination (Mazarico et al. 2011): https://pgda.gsfc.nasa.gov/products/69 |
| `data/kernels/de440s.bsp` | JPL planetary ephemeris (SPICE SPK) | NAIF generic kernels: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/ |
| `data/kernels/naif0012.tls` | Leap seconds kernel | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/ |
| `data/kernels/pck00011.tpc` | Planetary constants kernel | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/ |
| `data/kernels/moon_pa_de440_200625.bpc` | Lunar orientation (binary PCK) | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/ |
| `data/kernels/moon_de440_220930.tf` | Lunar frame kernel | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/ |
| `data/horizon_masks/` | Output of `pipeline/compute_horizon_masks.py`: one JSON horizon mask per candidate site, plus plots | generated, not downloaded |

The global 1/8° terrain layer comes from the LLNL `ssa-data-lunar` package (LOLA-derived); see `pipeline/build_browser_terrain.py`. `docs/Lunar_Site_Navigator_Technical_Review.md` lists every source with references.
