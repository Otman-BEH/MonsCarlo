# Mons Carlo backend

This is the Python service behind Mons Carlo. Give it a lunar site, a date and a lander and it tells you where the Sun
and Earth are against the real terrain horizon, when there is power and a radio link, and whether that lander survives
its mission there. It can also run a Monte Carlo landing-risk analysis on top.

It is one FastAPI service built from three packages:

- `monscarlo/prep/`: the only part that talks to NASA and JPL or writes data. It downloads and checks the raw files
  listed in `manifest.json`, precomputes derived products, and pulls Sun and Earth positions from the JPL Horizons API
  one month at a time into SQLite. SPICE is the fallback when Horizons can't be reached.
- `monscarlo/engine/`: the NumPy analysis that reads what `prep/` produced. Geometry, terrain and horizon masks,
  visibility, landers, the mission simulation and the Monte Carlo all live here. It was ported from the original
  in-browser engine and checked against it (see Validation).
- `monscarlo/api/`: the HTTP layer (routes and request schemas).

The web page in `../web/` is a separate static frontend. It asks these endpoints for every number and only does the
drawing, and it is served on its own (`python serve_web.py` from the repo root). The API accepts cross-origin calls; set
`MONS_CARLO_CORS_ORIGINS` (a comma list) to limit them to the page's address once it is hosted. The original single-file
app, which had its own engine in the browser, is in the git history at commit `afd9e78`.

## Install

Python 3.12 to 3.14.

```
cd backend
python -m venv .venv
.venv\Scripts\activate            (Windows)     or     source .venv/bin/activate     (macOS, Linux)
pip install -r requirements.txt
```

## Run

```
python run.py
```

This goes through four steps, and each one skips whatever is already done:

1. **Data files**: checks every required file in `manifest.json` (size, plus sha256 the first time) and downloads what's
   missing from NASA PGDA and JPL NAIF. That's about 620 MB, and broken downloads resume. If you already have the files,
   copy them into `backend/data/raw/` first and nothing gets downloaded.
2. **Precompute**: converts the compressed regional DEMs to `.npy` so they can be memory-mapped, averages the 80 m DEM
   down to the 400 m raster the page draws shadows from, and casts the horizon of every listed polar site (720
   azimuths, heights from 0 to 100 m, both terrain modes). Around 10 s on an Apple M1, then skipped while the stamp
   matches.
3. **Ephemeris**: pre-fetches 14 months of hourly Sun and Earth vectors from JPL Horizons (28 requests, about 40 s).
   Months that fail come from SPICE instead and get replaced with Horizons data on a later run.
4. **API** on http://127.0.0.1:8000, with interactive documentation at `/docs`.

Flags: `--skip-fetch`, `--skip-prefetch`, `--all-data` (also grabs the optional files: illumination maps, hillshade,
extra 5 m tiles), `--months`, `--host`, `--port`, `--no-serve`. Data goes in `backend/data/` unless `MONS_CARLO_DATA`
points somewhere else.

## Endpoints

One call answers the challenge question, and the rest give you every number behind it.

| Endpoint | What it returns |
|---|---|
| `GET /report` (also POST) | Everything for a site and date: a one-sentence summary, the sky right now, 30-day window statistics, the mission verdict, sources, and links to the detailed endpoints. Only the location is required. `include=series,horizon,risk,trace` adds the heavy parts. |
| `GET /sky` | Sun and Earth now: azimuth, elevation, angular radius, horizon height, clearance, visible share of the disc, Sun irradiance, and the next sunset, sunrise, Earthset and Earthrise (refined to the second). |
| `GET /windows` | Sunlit, Earth-in-view and both-at-once intervals over a period, percentages, the longest dark period and radio gap, and an optional hourly series; `format=csv` works too. |
| `GET /mission`, `POST /mission` | A verdict (meets, marginal, fails) with reasons, nominal and terrain-margin results, an optional battery trace (`trace=true`) and an optional Monte Carlo landing risk (`risk=true`). GET takes the reference lander plus flat overrides; POST takes the full nested lander, mission and uncertainty. |
| `GET /horizon` | The terrain horizon: 720 azimuths at one or more heights (`height_m=2,10`). |
| `GET /sites`, `GET /health` | The site catalogue (26 sites) and data readiness. |
| `GET /landers`, `GET /landers/{id}`, `POST /landers`, `DELETE /landers/{id}` | Lander presets and saved custom landers (SQLite). |
| `POST /design` | Design lab: the survival frontier (smallest array for 36 battery sizes, with and without the terrain margin), the lightest pair, ways to make the current design pass or get lighter, and a 60-day atlas of the lightest design per landing time. |
| `POST /calendar` | The verdict for a landing on each of up to 400 days, for up to 8 sites, with the first cause of failure. |
| `POST /rescue` | After a schedule slip: the plan's verdict before and after the slip, plus other sites and landing times ranked by verdict, extra wait and battery margin. |
| `GET /series`, `GET /ephemeris` | The hourly series and horizon for a site, and hourly Moon-fixed Sun and Earth vectors. The page uses these for charts and smooth playback. |
| `GET /dsn` | Moon elevation at the three Deep Space Network complexes (SPICE). |
| `GET /terrain/rings`, `GET /terrain/polar400`, `GET /terrain/moon.jpg` | Binary height grids around a site (10 m within 1.5 km, 40 m within 6 km, 160 m within 30 km, from the 5 m maps where they exist), the 400 m south-pole raster (both row-delta coded), and the Moon mosaic. These feed the surface view, the shadow map and the globe. |

Optional physics refinements, all off by default so results match the original engine: `lander.power.array.incidence_loss`
(fixed panels lose the light the cover glass reflects at a slant: Fresnel, n = 1.5), `lander.power.battery.discharge_eff`,
`mission.link_min_clearance_deg` (the link counts only while Earth's centre is this far above the terrain; 0.95 keeps the
whole disc clear) and `mission.limb_darkening` (0.6 for the Sun in visible light). The page's "Stricter physics" switch
turns all four on. `tests/test_physics_options.py` covers them.

Common inputs: the location as `site=<id>` or `lat=&lon=` (east positive); `time=` or `start=`/`end=` (ISO 8601 UTC,
defaulting to now and 30 days); `lander=<id>` plus overrides; `dem=best|80m`. Every response carries `meta` with the
ephemeris source for each month, the terrain tiers and citations, `lander_resolved` (the exact lander used) and
`defaults_used`. Monte Carlo responses also include the seed.

Errors: 404 for an unknown site or lander, 422 for invalid input, 400 outside 1900 to 2100, 503 when no ephemeris can be
produced or the server is busy (see below), and 403 for lander changes on a read-only server.

### Running it in public

- `MONS_CARLO_READONLY=1` turns off saving and deleting landers.
- `MONS_CARLO_HEAVY_JOBS` (default 2) sets how many heavy jobs (landing risk, design lab, rescue, calendar) run at once.
  Others wait up to 45 s, then get a 503 with `Retry-After`.
- Heavy results are kept in memory (the last 128) and reused when someone asks the same question again.
- `MONS_CARLO_CORS_ORIGINS` is a comma list of page addresses allowed to call the API (default: any).

### Examples

```
curl "http://127.0.0.1:8000/report?site=shack"
curl "http://127.0.0.1:8000/sky?site=mala&time=2026-12-01T06:00:00Z&antenna_height_m=10"
curl "http://127.0.0.1:8000/windows?lat=-85.42&lon=31.62&start=2026-12-01T00:00:00Z&format=csv"
curl "http://127.0.0.1:8000/mission?site=ridge&landing_time=2026-12-20T00:00:00Z&battery_wh=4000&max_gap_h=72&risk=true"
curl -X POST http://127.0.0.1:8000/mission -H "Content-Type: application/json" -d "{\"location\": {\"site\": \"shack\"}, \"landing_time\": \"2026-12-14T00:00:00Z\", \"lander\": \"polar-vertical\", \"mission\": {\"duration_days\": 14, \"fault\": {\"kind\": \"array\", \"day\": 3}}, \"risk\": true, \"uncertainty\": {\"heading_random\": true}}"
curl -X POST http://127.0.0.1:8000/landers -H "Content-Type: application/json" -d "{\"base\": \"reference\", \"id\": \"big-battery\", \"name\": \"Reference, 5 kWh\", \"power\": {\"battery\": {\"capacity_wh\": 5000}}}"
```

Here's the kind of summary `/report` gives back:

> At Shackleton rim on 1 Dec 2026 the Sun is 2.4° above the horizon and sets in 62 d 7 h; Earth is hidden until
> Earthrise in 12 d 21 h. Over the next 30 days: sunlit 100%, Earth in view 45%, both 45%. Reference small lander,
> 10-day mission landing then: fails, because no Earth line of sight at landing.

### Command line

Same endpoints and parameter names, either in-process (no server needed) or against a running server:

```
python -m monscarlo report site=shack --text
python -m monscarlo mission site=shack landing_time=2026-12-14T00:00:00Z risk=true
python -m monscarlo windows site=mala format=csv > mala.csv
python -m monscarlo --url http://127.0.0.1:8000 sky site=pole
```

## Landers

A lander is the hardware: array, battery, loads, safe mode, antenna height, landing accuracy and slope limit. A mission
is what you ask of it: landing time, duration, Earth link, longest gap, blackout rule, terrain margin and an optional
fault. Uncertainty settings belong to the Monte Carlo. Field names carry their units, and the full schema is on `/docs`.

- Solar arrays can be `tracking` (always faces the Sun), `horizontal` (output times the sine of the Sun's elevation), or
  `vertical` with 1 to 8 fixed faces pointing in set directions relative to the lander heading. We ignore
  self-shadowing between faces.
- The Sun and Earth get separate heights: the Sun is judged against the horizon at the array height, Earth against the
  horizon at the antenna height.
- Presets: `reference` (the original app's default lander), `polar-vertical` and `horizontal-deck`. All three are
  illustrative. We haven't added a real lander yet.

## Terrain

| Tier | Source | Used |
|---|---|---|
| 5 m site tiles | PGDA product 78 (Site01, 04, 07, 11; LM4, LM6, Haworth, Site23 optional) | `best` mode, out to the tile edge |
| 80 m | `LDEM_80S_80MPP_ADJ.TIF`, PGDA product 90 | 80°S to the pole, out to 60 km in `best` mode |
| 240 m | `LDEM_60S_240MPP_ADJ.TIF`, PGDA product 90 | 60°S to the pole, out to 330 km |
| coarse | LOLA global grid in `monscarlo/assets` (1/4°, polar caps 1/8° by 1/4°) | everywhere else |

`dem=80m` reproduces the original app exactly: the 80 m DEM on its distance schedule, with the coarse grid beyond.
Listed polar sites use the original app's snapped coordinates (highest ground within 600 m).

**What the 5 m tiles change** (`python tools/compare_5m.py`), 12 months from 15 Nov 2026, 2 m mast:

| Site | 5 m tile | horizon diff max | horizon diff RMS | sunlit %, 80 m to 5 m | Earth in view %, 80 m to 5 m |
|---|---|---|---|---|---|
| Shackleton rim | Site04 | 1.47° | 0.33° | 86.0 to 82.0 | 51.3 to 51.3 |
| Connecting ridge | Site01 | 0.90° | 0.25° | 87.9 to 85.6 | 52.9 to 52.9 |
| de Gerlache rim | Site11 | 0.50° | 0.12° | 74.9 to 75.1 | 56.4 to 56.4 |
| Chang'e 7 target | Site07 | 0.77° | 0.26° | 56.4 to 55.6 | 57.0 to 56.9 |
| South pole | Site04 | 2.80° | 1.01° | 28.0 to 25.6 | 29.3 to 18.1 |

Finer terrain matters most where the ground close by is steep. At the pole, which sits on the wall of Shackleton, Earth
is in view 11 percentage points less of the year.

## Ephemeris

JPL Horizons is the main source. We make one OBSERVER request per body per calendar month from a reference point on the
lunar equator at longitude 0, asking for quantities 4 (apparent azimuth and elevation) and 20 (range). Each row rebuilds
the Moon-fixed Sun or Earth vector exactly, and `engine.geometry.look()` turns that into the view from any site. So two
requests a month cover every site, custom point and Monte Carlo cell. Months stay cached in SQLite for good, since the
predictions don't change. If Horizons fails, the month comes from SPICE (`spkpos(..., 'MOON_ME', 'LT+S', 'MOON')`, DE440
kernels) and is flagged so a later run replaces it. Event times between the hourly samples use 4-point Lagrange
interpolation and then bisection.

## Validation

`python -m pytest` runs 94 tests, and `-m live` adds two live Horizons checks. Tests that need the NASA data or SPICE
kernels skip themselves until `python run.py` has downloaded them. The parity fixtures come from the original JS engine
(`backend/tools/make_golden.js`, run on a checkout of commit `afd9e78`; the comment at the top of the file explains how).

| Check | Result |
|---|---|
| Series (`look`, disc fraction, clearance, irradiance) vs the original JS, same ephemeris table | equal to float32 rounding (the original stored Float32Array) |
| Mission and verdict vs the original, 48 cases (8 configs, all fault kinds, safe mode) | identical verdicts, failure messages and battery traces |
| Random numbers and `mix` vs the original | bit-exact (see the note on Math.log below) |
| `cellTrials`, `aimStats`, `wilson` vs the original | within 1e-9 |
| Site horizons, `80m` mode vs the original `profileMask`, heights 2, 5, 10 m | within 0.05° (im1: 0.051°, see note) |
| Same, eye height 0 m | within 0.14° (see note) |
| Custom polar point, 80 m DEM vs the original 400 m browser raster | mean 0.25°, max 1.07° (different resolution, expected) |
| Custom points away from the pole vs the original | exact |
| SPICE DE440 vs the DE421 truth file (`tests/fixtures/truth.json`, 3,166 epochs, 6 sites) | largest difference 0.000015° |
| Horizons reconstruction vs SPICE (December 2026, 4 sites) | largest difference 0.00001° |
| `/sky` and `/mission` through the API (Horizons ephemeris) vs the original JS (Astronomy Engine) | under 0.01°, same verdicts |
| Monte Carlo, stacked simulation vs the per-cell `cellTrials` port | identical per-cell results |
| Design lab (frontier, lightest pair, minimum battery, atlas) vs the original, 3 cases | identical |
| DSN Moon elevation vs the original (Astronomy Engine) | within 0.06° above 15° elevation (the original adds atmospheric refraction, which only matters near the horizon) |

Notes:

- **Eye height 0 m.** At 0 m the horizon is set by terrain about 30 m away, so a few centimetres of height rounding
  shift the angle by around 0.1°. The original profiles used float32 heights. From 2 m up the two agree within 0.05°.
- **im1** is 30 km from the edge of the 80 m DEM, so part of its horizon comes from the coarse grid. The original used
  ssa-data-lunar's 1/8° grid there; we use the grid in `monscarlo/assets` (1/4° in longitude) and don't install
  ssa-data-lunar.
- **Math.log.** The original's normal random numbers go through V8's `Math.log` (fdlibm). On Apple Silicon the compiler
  fuses multiply-adds, which changes the last bit of roughly 1 result in 400. We port fdlibm both ways:
  `Rng(seed, fma=True)` matches Node on arm64 bit for bit (checked on 20,000 inputs, and the golden file was made on
  arm64), and the default plain version is what x64 builds should produce. That one hasn't been checked on an x64
  machine yet.

Latency on an Apple M1 with a warm cache (our targets in brackets): `/sky` 4 ms (200 ms), `/windows` over 30 days 2 ms
(300 ms), `/mission` 3 ms (300 ms), `/report` 5 ms (500 ms), a custom-point `/horizon` in `best` mode 0.5 to 0.6 s
(2 s), and the Monte Carlo with 15 x 15 cells x 48 trials, drivers and best aim 0.7 to 3.6 s (15 s). The first request
for a month that isn't cached yet adds about 2 s per month for Horizons. We haven't timed it on Windows.

## Data and citations

Every external file is listed in `manifest.json` with its URL, size, sha256 and citation. The sha256 values come from
files downloaded on 15 Nov 2026, and their sizes match our existing local copies byte for byte, so
`python -m monscarlo.prep.fetch_data --full` should verify those copies too.

- LOLA south polar DEMs: Barker et al. 2021, PGDA product 90, https://pgda.gsfc.nasa.gov/products/90
- LOLA 5 m site DEMs: Barker et al. 2021, Planetary and Space Science 203, 105119, PGDA product 78,
  https://pgda.gsfc.nasa.gov/products/78
- Polar illumination maps (optional): Mazarico et al. 2011, Icarus 211, 1066, PGDA product 69,
  https://pgda.gsfc.nasa.gov/products/69
- SPICE kernels: JPL NAIF, https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ (NAIF has moved
  `moon_de440_220930.tf` to `fk/satellites/a_old_versions/`, and the manifest points there)
- Ephemeris: JPL Horizons API, https://ssd.jpl.nasa.gov/horizons/

The raw files really do come from these NASA servers (or are checked against their checksums), and the positions really
do come from the Horizons API. Every response says which source served each month.

## Design notes

- The coarse global grid ships in `monscarlo/assets/`. It was taken from the original app's packed data, which came
  from the `ssa-data-lunar` package, so the package itself isn't installed. The Moon mosaic for the page's globe lives
  there too.
- `imagecodecs` is an extra dependency because the PGDA regional DEMs are deflate-compressed with a floating-point
  predictor.
- Optional files (hillshade, illumination maps, LM4, LM6, Haworth, Site23) are only fetched with `--all-data`, so a
  fresh clone downloads about 620 MB instead of 1.2 GB. When Site23 is present, Malapert (`mala`) gets a 5 m tier.
- Monte Carlo cells use a faster horizon cast: the finest tier at each point on a 30 m to 330 km distance schedule, at
  180 azimuths. Compared with the full tiered cast the mean difference is 0.03°.
- `engine/service.py` holds the endpoint logic that the API and the command line share.

## Layout

```
backend/
  run.py, manifest.json, requirements.txt
  monscarlo/config.py
  monscarlo/prep/     fetch_data.py, precompute.py, horizons.py, spice.py, store.py
  monscarlo/engine/   geometry.py, ephemeris.py, terrain.py, sites.py, visibility.py, landers.py, power.py,
                      mission.py, montecarlo.py, design.py, planning.py, service.py, report.py,
                      sites.json, presets/landers.json
  monscarlo/api/      app.py, routes.py, schemas.py
  monscarlo/assets/   coarse LOLA grid
  tools/              make_golden.js (parity fixtures from the original app), compare_5m.py
  tests/              pytest suite and fixtures (golden JSON from the original app, recorded Horizons months)
  data/               (not in git) raw/, derived/, monscarlo.db
```
