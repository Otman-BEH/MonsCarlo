# Mons Carlo backend

A local Python service for Mons Carlo. It answers, for any lunar site, date and lander: where are the Sun and Earth
against the real terrain skyline, when is there power and a radio link, and does this lander survive the mission there
(optionally with a Monte Carlo landing risk).

Two packages in one FastAPI service:

- `skyline/prep/`: the only part that talks to NASA and JPL and writes data. It downloads and checks the raw files
  (`manifest.json`), precomputes derived products, and fetches Sun and Earth positions from the JPL Horizons API month by
  month into SQLite, with SPICE as the fallback.
- `skyline/engine/`: NumPy analysis that reads what `prep/` produced: geometry, terrain and skylines, visibility,
  landers, the mission simulation and Monte Carlo. Ported from main's `src/engine.js`, `src/terrain.js`,
  `src/analysis.js` and `src/app.js`, and checked against them (see Validation).

The same server also serves the web page (`../web/`) at `/`: the page fetches every number from the endpoints below and
only draws. The original single-file app, with its own in-browser engine, was retired (git history, commit `afd9e78`);
the engine here was ported from it and checked against it.

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

This runs, in order, and every step skips work already done:

1. **Data files**: checks every required file in `manifest.json` (size, and sha256 on first check) and downloads what
   is missing from NASA PGDA and JPL NAIF (about 620 MB; resumes broken downloads). On the team laptop, copy the
   existing `data\` subfolders into `backend/data/raw/` first and nothing is downloaded.
2. **Precompute**: converts the compressed regional DEMs to `.npy` for fast memory-mapping, averages the 80 m DEM to
   the 400 m raster the page draws shadows from, and casts the skylines of every listed polar site (720 azimuths, heights 0 to 100 m, both terrain
   modes). About 10 s on an Apple M1, then skipped while the stamp matches.
3. **Ephemeris**: pre-fetches 14 months of hourly Sun and Earth vectors from JPL Horizons (28 requests, about 40 s),
   then 14 months of the Deep Space Network view (3 requests a month, 42 in all). If Horizons cannot be reached, those
   months come from SPICE and are replaced by Horizons data on a later run.
4. **Server** on http://127.0.0.1:8000: the web page at `/`, interactive API documentation at `/docs`.

Flags: `--skip-fetch`, `--skip-prefetch`, `--all-data` (also the optional files: illumination maps, hillshade, extra
5 m tiles), `--port`, `--no-serve`. The data directory is `backend/data/` unless `SKYLINE_DATA` points elsewhere.

## Endpoints

"One call answers the challenge question. Five more give you every number behind it."

| Endpoint | What it returns |
|---|---|
| `GET /report` (also POST) | Everything for a site and date: a one-sentence summary, the sky now, 30-day window statistics, the mission verdict, sources and links to the detailed endpoints. Only the location is required. `include=series,horizon,risk,trace` adds the heavy parts. |
| `GET /sky` | Sun and Earth now: azimuth, elevation, angular radius, skyline height, clearance, visible share of the disc, Sun irradiance, next sunset, sunrise, Earthset and Earthrise (refined to the second). |
| `GET /windows` | Sunlit, Earth-in-view and both-at-once intervals over a period, percentages, longest dark period and radio gap, optional hourly series; `format=csv`. |
| `GET /mission`, `POST /mission` | Verdict (meets, marginal, fails) with reasons, nominal and terrain-margin results, optional battery trace (`trace=true`) and Monte Carlo landing risk (`risk=true`). GET takes the reference lander plus flat overrides; POST takes the full nested lander, mission and uncertainty. |
| `GET /horizon` | The skyline: 720 azimuths, one or more heights (`height_m=2,10`). |
| `GET /sites`, `GET /health` | Site catalogue (26 sites); data readiness. |
| `GET /landers`, `GET /landers/{id}`, `POST /landers`, `DELETE /landers/{id}` | Lander presets and saved custom landers (SQLite). |
| `GET /map` | **Sunlight and Earth-view map** of the south pole (80°S to the pole) for one hour: `layer=sun\|earth`, `size=100..1200` (400 = main's 1.52 km grid), `format=png` (coloured as main draws it) or `json` (visible share and, for the Sun, incidence as base64 `uint8`, plus `hillshade=true`), `sites=true` for the catalogue sites' pixel positions. Projection, extent, pixel size and the Sun and Earth sub-points come with it, so a click turns into lat and lon. Rounds to the hour unless `exact=true`. |
| `GET /compare` | **Site compare**: 2 to 8 sites (`sites=shack,ridge,mala`) and/or points (`points=-89.45,222.7;-85.4,31.6`) over the same window, with exactly the `/windows` statistics per site as parallel arrays, `best_by` (the best site per column; the API does not pick a winner), the verdict at `landing_time`, and `include=panorama` (each skyline at 180 azimuths and the Sun and Earth paths over 29.5 days for one instant). |
| `GET /dsn` | **DSN station view**: Moon azimuth and elevation at Goldstone, Madrid and Canberra, at one `time` or hourly from `start` to `end` with intervals above `min_el_deg` (default 10) per station and for any station. `dsn=true` on `/sky` lists the stations that see the Moon; on `/windows` it adds `contact` intervals (Earth above the skyline and a station above `min_el_deg`). |
| `GET /landing-window`, `POST /landing-window` | **Landing window** (main's Mission Rescue): the plan's verdict, the verdict after `slip_days` (default 0, so it also answers "when are the next windows here?"), then the sites (`scope=pole\|all` or `sites=`) ranked by verdict, earliest landing and lowest charge, each with its best landing time, good landing days, reason, the windows (runs of landing times that meet the needs) and links to `/report` and `/mission-design`. `needs_dsn_at_landing=true` drops landing times when no station sees the Moon. |
| `GET /mission-design`, `POST /mission-design` | **Mission design** (main's design lab): the survival frontier (smallest array for 36 battery sizes, with and without the terrain margin), the lightest pair, your design, the fixes (numbers and main's sentences), both battery traces, and a lander body for `POST /landers` ("use this design"). Mass figures: query, else the lander's `mass` block, else 80 W/kg and 160 Wh/kg (all reported in `defaults_used`). |
| `GET /mission-design/atlas`, `POST /mission-design/atlas` | **Opportunity atlas**: the lightest design for a landing every `step_h` (12) hours over `days` (60) from 5 days before the landing day, nulls where nothing works, and the 4 best dates at least 3 days apart with links. |
| `POST /calendar` | Verdict for a landing on each of up to 400 days, for up to 8 sites, with the first failure cause. |
| `POST /design`, `POST /rescue` | Deprecated: the earlier forms of `/mission-design` and `/landing-window`, kept so older pages keep working. |
| `GET /series`, `GET /ephemeris` | Hourly series and skyline for a site, and hourly Moon-fixed Sun and Earth vectors (used by the page for charts and smooth playback). |
| `GET /terrain/patch`, `GET /terrain/polar400`, `GET /terrain/moon.jpg` | Height grids around a site (40 m within 3 km, 240 m within 15 km), the 400 m south-pole raster and the Moon mosaic, for drawing the surface view, the shadow map and the globe. |

Common inputs: location `site=<id>` or `lat=&lon=` (east positive); `time=` or `start=`/`end=` (ISO 8601 UTC, default
now and 30 days); `lander=<id>` plus overrides; `dem=best|80m`. Every response has `meta`: ephemeris source per month,
terrain tiers and citations, `lander_resolved` (the exact lander used) and `defaults_used`. Monte Carlo responses also
carry the seed.

Errors: 404 unknown site or lander, 422 invalid input, 400 outside 1900 to 2100, 503 when no ephemeris can be produced.

### Examples

```
curl "http://127.0.0.1:8000/report?site=shack"
curl "http://127.0.0.1:8000/sky?site=mala&time=2026-12-01T06:00:00Z&antenna_height_m=10"
curl "http://127.0.0.1:8000/windows?lat=-85.42&lon=31.62&start=2026-12-01T00:00:00Z&format=csv"
curl "http://127.0.0.1:8000/mission?site=ridge&landing_time=2026-12-20T00:00:00Z&battery_wh=4000&max_gap_h=72&risk=true"
curl -X POST http://127.0.0.1:8000/mission -H "Content-Type: application/json" -d "{\"location\": {\"site\": \"shack\"}, \"landing_time\": \"2026-12-14T00:00:00Z\", \"lander\": \"polar-vertical\", \"mission\": {\"duration_days\": 14, \"fault\": {\"kind\": \"array\", \"day\": 3}}, \"risk\": true, \"uncertainty\": {\"heading_random\": true}}"
curl -X POST http://127.0.0.1:8000/landers -H "Content-Type: application/json" -d "{\"base\": \"reference\", \"id\": \"big-battery\", \"name\": \"Reference, 5 kWh\", \"power\": {\"battery\": {\"capacity_wh\": 5000}}}"
```

A summary from `/report`:

> At Shackleton rim on 1 Dec 2026 the Sun is 2.4° above the skyline and sets in 62 d 7 h; Earth is hidden until
> Earthrise in 12 d 21 h. Over the next 30 days: sunlit 100%, Earth in view 45%, both 45%. Reference small lander,
> 10-day mission landing then: fails, because no Earth line of sight at landing.

### Command line

The same endpoints and parameter names, in-process (no server needed) or against a running server:

```
python -m skyline report site=shack --text
python -m skyline mission site=shack landing_time=2026-12-14T00:00:00Z risk=true
python -m skyline windows site=mala format=csv > mala.csv
python -m skyline --url http://127.0.0.1:8000 sky site=pole
python -m skyline compare sites=shack,ridge,mala include=panorama
python -m skyline landing-window site=mala plan_time=2026-12-01T06:00:00Z slip_days=14
python -m skyline mission-design site=mala landing_time=2026-12-14T00:00:00Z
python -m skyline mission-design/atlas site=mala
python -m skyline map layer=earth format=png > earth.png
```

## Landers

A lander is hardware (array, battery, loads, safe mode, antenna height, landing accuracy, slope limit). A mission is what
is asked of it (landing time, duration, Earth link, longest gap, blackout rule, terrain margin, fault). Uncertainty
settings belong to the Monte Carlo. Field names carry their units; the full schema is on `/docs`.

- Solar arrays: `tracking` (always faces the Sun), `horizontal` (output times the sine of the Sun's elevation), or
  `vertical` with 1 to 8 fixed faces at set directions relative to the lander heading. Self-shadowing between faces is
  ignored.
- Separate heights: the Sun is judged against the skyline at the array height, Earth against the skyline at the antenna
  height.
- Presets: `reference` (main's default lander), `polar-vertical` and `horizontal-deck`. All three are labelled
  illustrative; no real-lander preset has been added yet (see Open questions).

## Terrain

| Tier | Source | Used |
|---|---|---|
| 5 m site tiles | PGDA product 78 (Site01, 04, 07, 11; LM4, LM6, Haworth, Site23 optional) | `best` mode, out to the tile edge |
| 80 m | `LDEM_80S_80MPP_ADJ.TIF`, PGDA product 90 | 80°S to the pole, out to 60 km in `best` mode |
| 240 m | `LDEM_60S_240MPP_ADJ.TIF`, PGDA product 90 | 60°S to the pole, out to 330 km |
| coarse | LOLA global grid in `skyline/assets` (1/4°, polar caps 1/8° by 1/4°) | everywhere else |

`dem=80m` reproduces main: the 80 m DEM with main's distance schedule (`build/hires.py`), coarse grid beyond. Listed
polar sites use main's snapped coordinates (highest ground within 600 m).

**What the 5 m tiles change** (`python tools/compare_5m.py`), 12 months from 15 Nov 2026, 2 m mast:

| Site | 5 m tile | skyline diff max | skyline diff RMS | sunlit %, 80 m to 5 m | Earth in view %, 80 m to 5 m |
|---|---|---|---|---|---|
| Shackleton rim | Site04 | 1.47° | 0.33° | 86.0 to 82.0 | 51.3 to 51.3 |
| Connecting ridge | Site01 | 0.90° | 0.25° | 87.9 to 85.6 | 52.9 to 52.9 |
| de Gerlache rim | Site11 | 0.50° | 0.12° | 74.9 to 75.1 | 56.4 to 56.4 |
| Chang'e 7 target | Site07 | 0.77° | 0.26° | 56.4 to 55.6 | 57.0 to 56.9 |
| South pole | Site04 | 2.80° | 1.01° | 28.0 to 25.6 | 29.3 to 18.1 |

The finer terrain matters most where the near field is steep: at the pole (on the wall of Shackleton) Earth is in view
11 points less of the year.

## Ephemeris

JPL Horizons is the primary source: one OBSERVER request per body per calendar month from a reference point on the
lunar equator at longitude 0, quantities 4 (apparent azimuth and elevation) and 20 (range). Each row rebuilds the
Moon-fixed Sun or Earth vector exactly, and `engine.geometry.look()` gives the view from any site, so two requests a
month serve every site, custom point and Monte Carlo cell. Months are cached in SQLite forever (predictions do not
change). If Horizons fails, the month comes from SPICE (`spkpos(..., 'MOON_ME', 'LT+S', 'MOON')`, DE440 kernels) and is
marked so a later run replaces it. Event times between hours use 4-point Lagrange interpolation, then bisection.

## Deep Space Network view

Same rule as the ephemeris: JPL Horizons first, one OBSERVER request per station per month (target Moon `301`,
`CENTER='coord@399'` at the station's geodetic coordinates, quantity 4, airless), cached in the SQLite tables `dsn` and
`dsn_months`. The SPICE fallback takes the Moon from DE440 in J2000 and turns it to Earth-fixed with IAU 1976
precession and Greenwich mean sidereal time (UT1 taken as UTC); stations on the pck00011 ellipsoid. It does not use
pck00011's `IAU_EARTH` frame, which turns with TDB instead of UT1 and put the Moon 0.07° off at the stations. Elevations
are geometric (no refraction); main's status panel added refraction, which only matters near the horizon.

## Validation

`python -m pytest` (124 tests; `-m live` adds three live Horizons checks). Parity fixtures come from main's JS engine:
`backend/tools/make_golden.js` and, for the phase 2 endpoints, `backend/tools/make_golden_phase2.js` (kept separate so
the arm64 `golden.json` is not regenerated by accident), both run on a checkout of commit `afd9e78`, which still has the
original engine; see the comment at the top of each file. The map, Mission Rescue and the atlas were not exported from
main's `src/app.js`, so the phase 2 script rebuilds them with main's loops, line for line.

| Check | Result |
|---|---|
| Series (`look`, disc fraction, clearance, irradiance) vs main's JS, same ephemeris table | equal to float32 rounding (main stores Float32Array) |
| Mission and verdict vs main, 48 cases (8 configs, all fault kinds, safe mode) | identical verdicts, failure messages, battery traces |
| Random numbers and `mix` vs main | bit-exact (see note on Math.log below) |
| `cellTrials`, `aimStats`, `wilson` vs main | within 1e-9 |
| Site skylines, `80m` mode vs main's `profileMask`, heights 2, 5, 10 m | within 0.05° (im1: 0.051°, see note) |
| Same, eye height 0 m | within 0.14° (see note) |
| Custom polar point, 80 m DEM vs main's 400 m browser raster | mean 0.25°, max 1.07° (different resolution, expected) |
| Custom points off the pole vs main | exact |
| SPICE DE440 vs main's DE421 truth file (`tests/fixtures/truth.json`, 3,166 epochs, 6 sites) | largest difference 0.000015° |
| Horizons reconstruction vs SPICE (December 2026, 4 sites) | largest difference 0.00001° |
| `/sky` and `/mission` through the API (Horizons ephemeris) vs main's JS (Astronomy Engine) | under 0.01°; same verdicts |
| Monte Carlo, stacked simulation vs per-cell `cellTrials` port | identical per-cell results |
| Design lab (frontier, lightest pair, minimum battery, atlas) vs main, 3 cases | identical |
| DSN Moon elevation, SPICE fallback vs main's Astronomy Engine without refraction, one week hourly | largest difference 0.0024° (azimuth 0.007°); vs main's panel (with refraction) within 0.1° above 15° |
| Verdict scan (`engine/scan.py`) vs the scalar verdict, 6 configs incl. faults and safe mode | identical states, lowest charge and longest gap |
| Map vs main's `castPolar`, 400 px, 3 times, both layers, grid from main's 400 m raster (`dem=80m`) | identical up to the fixture's 16-bit rounding (largest difference 0.000008); hillshade identical |
| Map with the 80 m DEM (`dem=best`) vs the same map from main's 400 m raster | finding, not a pass or fail: 3.3% of pixels differ by more than 0.02 in visible share (1 Dec 2026), along shadow edges |
| Site compare vs `/windows` for the same window, and vs main's `Ana.stats` | identical to `/windows`; within 1e-6 of main |
| Landing window vs a JS rebuild of `computeRescue`, 3 plans, 9 sites | identical ranking, best landing times, verdicts, good-day counts and every 6-hour verdict; lowest charge within 1e-6 |
| Mission design vs `designFrontier`, `minArray`, `bisectUp` and drawLab's fixes, 4 configs (tracking, horizontal, array fault, safe mode) | values within 1e-9 (so every bisection step went the same way), identical lightest pair and identical fix sentences |
| Atlas vs a JS rebuild of `drawAtlas`'s loop, 2 cases of 120 landings | identical nulls, designs and 4 best dates; masses within 1e-9 |

Notes:

- **Eye height 0 m skylines.** At 0 m the skyline is set by terrain 30 m away, so a few centimetres of height rounding
  move the angle by about 0.1°. Main's profiles were computed with float32 heights; at 2 m and above the agreement is
  within 0.05°.
- **im1** is 30 km from the edge of the 80 m DEM, so part of its skyline comes from the coarse grid. Main's
  `build/hires.py` used ssa-data-lunar's 1/8° grid there; the backend uses the grid in `skyline/assets` (1/4° in longitude) and
  does not install ssa-data-lunar.
- **Math.log.** Main's normal random numbers go through V8's `Math.log` (fdlibm). On Apple Silicon the compiler fuses
  multiply-adds, which changes the last bit of about 1 result in 400. The backend ports fdlibm both ways:
  `Rng(seed, fma=True)` matches Node on arm64 bit for bit (checked on 20,000 inputs, and the golden file was made on
  arm64); the default plain version is what x64 builds should produce, not yet checked on an x64 machine.

Latency on an Apple M1 (warm cache; plan targets in brackets): `/sky` 4 ms (200 ms), `/windows` 30 days 2 ms (300 ms),
`/mission` 3 ms (300 ms), `/report` 5 ms (500 ms), custom-point `/horizon` in `best` mode 0.5 to 0.6 s (2 s), Monte
Carlo with 15 x 15 cells x 48 trials, drivers and best aim 0.7 to 3.6 s (15 s). A first request for a month not yet
cached adds about 2 s per month for Horizons. The Windows laptop has not been measured.

Phase 2 endpoints, measured on a 2-core Linux container (Intel Xeon 2.1 GHz, warm series cache, a new hour for each map
so every map is a real cast; plan targets in brackets): `/map` 400 px 0.14 s (0.3 s), 1200 px 2.1 s (3 s; the first
1200 px request also builds and saves its grid, about 0.7 s), `/compare` 4 sites over 30 days 6 ms (300 ms), `/dsn` 30
days 16 ms (100 ms), `/landing-window` 9 polar sites over 21 days at 6-hour steps 0.18 s (2 s), `/mission-design` 0.29 s
(1 s), `/mission-design/atlas` 1.0 s (5 s), so no job endpoint was needed. Mission design runs bisections with fewer
than 17 candidates through the scalar port of main's mission loop (0.3 ms each, against about 7 ms for one vectorised
pass), which took it from 1.5 s to 0.3 s. Measure again on the Windows laptop and record it here.

## Data and citations

Every external file is in `manifest.json` with its URL, size, sha256 and citation. The sha256 values were computed from
files downloaded on 15 Nov 2026; the sizes match the team laptop's copies byte for byte, so `python -m
skyline.prep.fetch_data --full` on the laptop should verify them (please run it once).

- LOLA south polar DEMs: Barker et al. 2021, PGDA product 90, https://pgda.gsfc.nasa.gov/products/90
- LOLA 5 m site DEMs: Barker et al. 2021, Planetary and Space Science 203, 105119, PGDA product 78,
  https://pgda.gsfc.nasa.gov/products/78
- Polar illumination maps (optional): Mazarico et al. 2011, Icarus 211, 1066, PGDA product 69,
  https://pgda.gsfc.nasa.gov/products/69
- SPICE kernels: JPL NAIF, https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ (NAIF has moved
  `moon_de440_220930.tf` to `fk/satellites/a_old_versions/`; the manifest points there)
- Ephemeris: JPL Horizons API, https://ssd.jpl.nasa.gov/horizons/

Honesty: the raw files really come from these NASA servers (or are verified against their checksums), and positions
really come from the Horizons API. Responses say which source served each month.

## Differences from the plan

- The coarse global grid ships in `skyline/assets/` (taken from the original app's packed data, which came from the
  `ssa-data-lunar` package); the package itself is not installed. The Moon mosaic for the page's globe is there too.
- `imagecodecs` is an extra dependency: the PGDA regional DEMs are deflate-compressed with a floating-point predictor.
- Optional files (hillshade, illumination maps, LM4, LM6, Haworth, Site23) are only fetched with `--all-data`, so a
  fresh clone downloads about 620 MB instead of 1.2 GB. Site23 (Malapert) is new: when present, `mala` gets a 5 m tier.
- Monte Carlo cells use a faster skyline cast (finest tier at each point on main's 30 m to 330 km distance schedule,
  180 azimuths). Against the full tiered cast the mean difference is 0.03°.
- An `engine/service.py` module holds the endpoint logic shared by the API and the command line.

## Open questions for the team

1. Lander presets: which real landers, with what sourced numbers? Only illustrative presets ship now.
2. Antenna mask angle beyond the terrain margin? Default: none (as main).
3. Vertical panel heading: fixed by default, `uncertainty.heading_random=true` for a uniform random heading per trial.
4. Run `python -m pytest -m live` on the laptop once to confirm Horizons from there, and `fetch_data --full` to confirm
   the checksums against the laptop copies.

## Layout

```
backend/
  run.py, manifest.json, requirements.txt
  skyline/config.py
  skyline/prep/     fetch_data.py, precompute.py, horizons.py, spice.py, store.py
  skyline/engine/   geometry.py, ephemeris.py, terrain.py, sites.py, visibility.py, landers.py, power.py,
                    mission.py, montecarlo.py, service.py, report.py, sites.json, presets/landers.json
  skyline/api/      app.py, routes.py, schemas.py
  tools/            make_golden.js (parity fixtures from main), compare_5m.py
  tests/            pytest suite and fixtures (golden JSON from main, recorded Horizons months)
  data/             (not in git) raw/, derived/, skyline.db
```
