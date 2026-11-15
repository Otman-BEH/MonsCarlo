# Mons Carlo

**A lunar landing site navigator.** Pick a site and a date, and Mons Carlo shows where the Sun and Earth sit against the
real terrain horizon, when power and radio windows open and close, and whether a lander survives its mission there.

Team Mons Carlo · NASA Space Apps Challenge 2026 · challenge: *Lunar Landing Site Navigator*

Live: https://mons-carlo.fly.dev (deployed from `main`)

## Why it exists

At the lunar south pole the Sun never climbs more than a degree or two above the horizon, and Earth bobs a few degrees
up and down each month. One ridge, or two metres of mast height, decides whether a lander has power and a radio link.
A table of Sun and Earth angles does not answer the question a mission planner asks, which is: *if I land here, on this
day, with this lander, does it make it?* Mons Carlo answers that, and shows why.

## What you can do

| Challenge objective | Where it is in Mons Carlo |
|---|---|
| Select and compare sites, curated or custom | 16 curated sites (Artemis candidates, CLPS, Chang'e, Chandrayaan-3, Apollo 11), any custom latitude and longitude, and a Compare view that puts several sites side by side over the same window |
| Flexible date and time | Any date and time from 1900 to 2100 (the next 14 months are preloaded), step buttons, a Play button, and a draggable timeline |
| Sun and Earth against the horizon, time to sunset and Earthset | Status cards, a 360° sky panorama with the terrain horizon, and next sunset, sunrise, Earthset and Earthrise to the second |
| Power and communication metrics | Solar power now for the chosen lander, sunlit and Earth-in-view hours, longest night and longest link gap, Deep Space Network station visibility |
| More than one visualisation | A first-person surface view rendered from the terrain, the sky panorama, a polar shadow map, a globe, a flat map, and timelines |
| Change over time | Paths of the Sun and Earth over the next lunar day, hour-by-hour timelines up to a year, and a landing-date calendar |
| Usable at every skill level | A 60-second tour, a "Why the pole?" page that compares Apollo 11 with Shackleton rim, plain-language captions on every chart, and a Method page with every assumption |

It then goes past the brief, under **Mission planning**:

- **Verdict.** An hour-by-hour simulation of the battery and the radio link for a chosen lander (12 presets, or your
  own numbers): meets the needs, marginal, or fails, with the reason.
- **Contingencies.** A degraded array or battery, extra load, a lost antenna, safe mode, stricter physics, a heat model.
- **Mission design.** The smallest solar array and battery that get through, and how that changes with the landing date.
- **Landing risk.** A Monte Carlo of thousands of landings scattered around the aim point, with terrain, hardware and
  timing uncertainty: the chance of success, why landings fail, and a better aim point when one exists. This is where
  the team name comes from.
- **If the launch slips.** Other sites and dates ranked after a schedule slip.

## How it works

1. **Positions.** Sun and Earth vectors in the Moon-fixed frame come from the JPL Horizons API, cached by month, with
   SPICE (DE440) as the fallback.
2. **Terrain.** Horizons are ray-cast from NASA LOLA elevation models: 5 m site maps where they exist, the 80 m and
   240 m south-polar maps, and a coarse global grid elsewhere. Each horizon is 720 azimuths at the height of the solar
   array (for the Sun) and of the antenna (for Earth).
3. **Everything else is those two tracks against that one curve.** Clearance above the terrain, the share of the solar
   disc showing, power, link windows, the mission simulation and the Monte Carlo are all built on it.

A Python backend (FastAPI, NumPy) does every calculation. The web page asks it for numbers and only draws them, so the
same numbers are available to anyone through the API (`/docs` on a running server; `/report?site=shack` answers the
challenge question in one call).

More detail: [backend/README.md](backend/README.md) (endpoints, data, validation).

## Run it

Python 3.12 to 3.14.

```
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

The first run downloads about 620 MB of NASA and JPL data, precomputes the site horizons and fetches the ephemeris;
later runs skip what is done. Then open http://127.0.0.1:8000. The page and the API are served from the same address.

Tests: `cd backend && python -m pytest` (107 tests; two live JPL Horizons checks only run with `-m live`).

## How we know it is right

| Check | Result |
|---|---|
| SPICE DE440 against an independent DE421 truth file, 3,166 epochs at 6 sites | largest difference 0.000015° |
| JPL Horizons against SPICE, December 2026 at 4 sites | largest difference 0.000006° |
| Python engine against the original in-browser engine: series, missions, Monte Carlo, design | identical verdicts and traces; see backend/README.md |
| Site horizons against the original engine's, mast heights 2 to 10 m | within 0.05° |
| Earth passing in front of the Sun, August 2026 to December 2028 | found on the dates of the five lunar eclipses in that period |
| Heat model step against a 1 s integration; eclipse overlap against a pixel count; Fresnel loss worked by hand | pass |

## What it does not do

- The radio link is geometry: Earth above the terrain, and a Deep Space Network complex with the Moon above 10°.
  There is no link budget, antenna pointing or dish scheduling.
- The mission simulation steps hourly. The heat model is one node with a thermostat, a first estimate and not a
  thermal design.
- Terrain is LOLA at 5 m at best. Rocks and metre-scale slopes that decide touchdown safety are below that.
- Landing-risk percentages are probabilities under the stated spreads, which are adjustable assumptions.
- The first-person view is drawn from the height maps. Texture finer than the maps is illustrative.

## Data and credits

- **Terrain:** NASA LOLA elevation models from the Planetary Geodynamics Data Archive (PGDA), products
  [78](https://pgda.gsfc.nasa.gov/products/78) and [90](https://pgda.gsfc.nasa.gov/products/90) (Barker et al. 2021).
- **Ephemeris:** [JPL Horizons API](https://ssd.jpl.nasa.gov/horizons/); SPICE kernels from
  [JPL NAIF](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/).
- **Coarse global grid and Moon image:** the LOLA-derived 1/4° global grid used away from the pole and the Moon mosaic
  on the globe come from LLNL's `ssa-data-lunar` package (MIT licence). Both ship in `backend/monscarlo/assets/`.
- **Method:** the horizon method of Mazarico et al. (2011, Icarus 211, 1066).
- **Reference values for checks:** the parity fixtures in `backend/tests/fixtures/` were produced with the original
  in-browser engine, which used [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT licence) for positions.
- **Lander presets and site coordinates:** published figures from ispace, Intuitive Machines, Firefly Aerospace, ISRO,
  Astrobotic, Blue Origin and NASA. Each preset in `backend/monscarlo/engine/presets/landers.json` names its source and
  marks every value that is our own estimate as assumed.
- **Server software:** FastAPI, Uvicorn, Pydantic, NumPy, SciPy, pandas, Requests, tifffile and imagecodecs (reading the
  LOLA GeoTIFFs), SpiceyPy with NAIF's CSPICE toolkit, and pytest with HTTPX for the tests. Exact versions are in
  `backend/requirements.txt`.
- **About page:** the team photos are our own. University and company logos belong to their owners and are shown only
  to say where each of us studies or works.

Every file, with its address, size, checksum and citation, is in `backend/manifest.json`. NASA does not endorse this
project.

## Layout

```
backend/   the API: prep/ (downloads, precompute, ephemeris), engine/ (analysis), api/ (routes), tests/
web/       the page: index.html, app.js, style.css, js/
```

## License

MIT, see [LICENSE](LICENSE).
