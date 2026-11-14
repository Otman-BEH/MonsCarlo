# Lunar Skyline

Team Mons Carlo, NASA Space Apps Challenge 2026.

Interactive mission-planning tool for the NASA Space Apps challenge "Lunar Landing Site Navigator".
It shows where the Sun and Earth sit against the terrain horizon of any lunar site on any date,
tests a mission against power and communication needs, and finds alternative sites and dates when a landing slips.

Open `index.html` in a browser. It is one self-contained file and works offline. To publish it, put this folder in a
public GitHub repository and turn on GitHub Pages for the main branch.

## What it does
- **Plan a mission**: enter mission length, array output, loads, battery, reserve, link-gap limit and a terrain margin.
  The page simulates battery charge hour by hour and gives a verdict: meets the needs, marginal (passes only without the terrain margin), or fails, with the reason.
- **Design lab**: works backwards from the mission to the hardware. A survival frontier shows every solar-array and battery pair that passes, the lightest pair is marked, and concrete fixes are listed (grow the array, grow the battery, or cut the load). An opportunity atlas repeats the search for a landing every 12 hours to show which dates need the least hardware. One tap applies a design, or a date and its design.
- **Blackout rule**: the battery must be able to carry the darkness load through an unplanned blackout (6 h by default) even at its lowest charge, so a tiny battery is not approved just because the Sun never sets.
- **Stress test**: inject one fault (array loses 30%, unexpected 100 W load, battery loses 25%, antenna down for 24 h) on a chosen mission day, with or without a safe mode that sheds load when the battery runs low.
- **Landing risk (Monte Carlo)**: thousands of missions are simulated with the touchdown point, landing time, terrain height and hardware varied at random; ground steeper than a set slope counts as a failure.
  The page reports the chance of success with a 95% interval, why missions fail, what drives the risk, a map of where a touchdown still works, and a better aim point when one holds up on a separate set of random draws.
  Every spread, the slope limit, the random seed and a "loads high, battery low together" link are adjustable.
- **Guided tour**: eight steps that walk a first-time visitor through the whole tool.
- **Mission Rescue**: set a plan, apply a schedule slip, and get a ranked list of sites and landing times that still meet the needs.
- **Stand at the landing site**: a first-person view of the real LOLA terrain from mast height, with cast shadows, and the Sun and Earth (with its phase) at true size. Drag to look around; press Play to watch a lunar day.
- **Explore the sky**: horizon panorama with the Sun's and Earth's paths, live south-pole shadow map, a 3D globe of the whole Moon lit from the true Sun direction (drag to turn, tap to pick a point), rise and set countdowns, time series.
  The surface view carries a compact readout: Sun and Earth clearance above the terrain and the time to the next set or rise.
- **Compare sites and dates**: one horizon panorama per site for the same instant, side-by-side statistics and a twelve-month landing-date calendar.
- **Why the south pole?**: a view for educators and the public. It pairs Apollo 11's sky with Shackleton rim's at the same moment, gives live figures for both (highest Sun, longest night, time with Earth in view), and explains the cause with an axis-tilt diagram.
- **Share and export**: "Copy link to this scenario" puts the site or custom coordinates, time, mast height, compared sites and mission needs in the address, so a colleague opens the same view. The time series (CSV) and the mission report (Markdown) can be copied or saved as files.

## Layout
- `index.html`        the built app (Astronomy Engine inlined)
- `lunar_skyline_walkthrough.ipynb`  Jupyter notebook: the challenge, the method in plain words, and the core calculations re-run in Python with charts
- `src/engine.js`     Sun/Earth vectors in the Moon body-fixed frame (Astronomy Engine + IAU lunar rotation), site geometry
- `src/terrain.js`    elevation grids, 80 m horizon profiles, in-browser ray casting
- `src/analysis.js`   per-site time series, rise/set search, statistics, mission and battery model
- `src/app.js`        user interface
- `build/pack.py`     packs the global LOLA grid and Moon mosaic (LLNL `ssa-data-lunar` package) into `build/data.json`
- `build/hires.py`    reads NASA's 80 m south-pole model and adds horizon profiles and a 400 m raster to `build/data.json`
- `build/patches.py`  cuts fine terrain patches (80 m within 3 km, 240 m within 15 km) around each listed site
- `build/truth.py`    reference Sun/Earth angles from JPL DE421 and the lunar orientation kernel through SPICE (MOON_ME frame) -> `build/truth.json`
- `build/validate.js` compares the engine with those reference values
- `build/horizons_check.js` compares the engine with NASA's live JPL Horizons service (needs a network connection)
- `build/test_core.js` unit tests for geometry, terrain, pole handling, rise/set search and the mission model
- `build/build.py`    assembles `index.html`, with Astronomy Engine inlined from `node_modules`
- `build/make_notebook.py` regenerates the notebook
- `docs/Lunar_Site_Navigator_Technical_Review.md`  review of data sources, methods, existing tools and candidate sites, with references

## Reproduce
    npm i astronomy-engine
    pip install numpy pillow scipy tifffile imagecodecs spiceypy lunarsky skyfield-data ssa-data-lunar
    # download LDEM_80S_80MPP_ADJ.TIF (189 MB) from https://pgda.gsfc.nasa.gov/products/90
    python3 build/pack.py
    python3 build/hires.py /path/to/LDEM_80S_80MPP_ADJ.TIF
    python3 build/patches.py /path/to/LDEM_80S_80MPP_ADJ.TIF
    python3 build/truth.py
    npm test            # ephemeris validation + 888 unit checks
    npm run check:horizons   # optional: compare with live JPL Horizons
    python3 build/build.py

## Accuracy
- Positions: 3,166 epochs (Nov 2026 to Dec 2028, every 6 h) at six sites against DE421/SPICE. Largest error 0.0042 deg in Sun or Earth elevation or azimuth.
- Independent check against NASA's live JPL Horizons service (DE441, observer on the lunar surface): 1,260 comparisons at six sites, weekly from Nov 2026 to Nov 2028. Largest difference 0.0038 deg (run on 14 Nov 2026 with `npm run check:horizons`).
- Terrain tiers, shown beside every site:
  - listed south-pole sites: horizons ray-cast at 80 m (720 directions, out to 330 km, seven mast heights from 0 to 100 m)
  - any other point south of 80 S: ray-cast in the browser from the same model (80 m within 3 km of a listed site, 240 m to 15 km, 400 m beyond); this matches the 80 m reference to about 0.05 deg near listed sites
  - elsewhere: LOLA grid at 1/8 deg (polar caps) or 1/4 deg
- Shackleton rim, Connecting ridge, de Gerlache rim and Malapert Massif are placed on the highest ground within 600 m of their published coordinates.

## Limits
- Power is geometric: array output in full Sun x visible fraction of the solar disc x (1 AU / distance)^2, with 90% charge efficiency.
  Temperature, dust, array pointing limits and degradation are not modelled.
- Earth contact is line of sight to Earth's centre. Antenna pointing, link margin and ground-station scheduling are not modelled.
- Hourly sampling can miss a visibility window shorter than an hour.
- The landing-risk analysis uses 80 m terrain only within 3 km of a listed site (400 m elsewhere). Its spreads are assumptions the user can change. Its 95% interval reflects the finite number of simulated missions only, not errors in the terrain data or in those assumptions. Slope is measured over about 160 m, so boulders and small craters are not seen.
- With safe mode on, a larger array can occasionally fail where a smaller one passes, because less load is shed. The design lab then reports a size that passes, which may not be the very smallest.
- Design-lab masses are screening figures (output and energy divided by the W per kg and Wh per kg entered); structure, wiring, thermal control and margins are not included.
- The stress test applies one fault at a time and safe mode is a simple rule; neither models real flight software. Rise and set times shown in the status panel are refined by bisection.
- Coordinates of planned missions are published targets. Check them before relying on a result.

## Future directions
- **Mission digital twin**: several faults at once, scheduled activities, and a planner that chooses recovery actions (delay a high-power task, change the communication schedule).
- **Hazard-scale landing safety**: slope, roughness and boulders from the 5 m LOLA site models and LROC images.
- **Finer landing-risk terrain**: run the Monte Carlo on the 5 m LOLA site models and on LOLA's own height-error maps, so boulder- and crater-scale hazards count.
- **Relay satellites**: add orbiters (for example ESA's Lunar Pathfinder) as a second way to reach Earth, which matters most for far-side and crater-floor sites.
- **Rover traverses**: plan a path and timing that keep a rover in sunlight and in contact, instead of a single fixed point.
- **Thermal model**: surface and hardware temperature through the lunar day and night, which often limits a mission before power does.
- **Other places**: the Moon's north pole needs only the matching LOLA file; Mercury's poles and Mars would need new terrain and rotation models.
- **Learned surrogate**: a small neural network trained on the ray-cast results could give instant whole-region illumination maps. It only makes sense once the physics-based maps exist to train and check it against.

## Data and credits
- NASA GSFC PGDA, "A New View of the Lunar South Pole from LOLA" (Barker et al.), LDEM_80S_80MPP_ADJ
- LOLA-derived global grid and Moon mosaic: LLNL `ssa-data-lunar` (MIT)
- Astronomy Engine by Don Cross (MIT)
- JPL DE421 ephemeris and lunar orientation kernels, used for validation
