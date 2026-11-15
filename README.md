# Lunar Skyline

Team Mons Carlo, NASA Space Apps Challenge 2026.

Interactive mission-planning tool for the NASA Space Apps challenge "Lunar Landing Site Navigator".
It shows where the Sun and Earth sit against the terrain horizon of any lunar site on any date,
tests a mission against power and communication needs, and finds alternative sites and dates when a landing slips.

Two separate parts:
- **Backend** (`backend/`): a Python API that does every calculation from NASA data.
- **Frontend** (`web/`): a static web page that asks the API and draws the answers. It finds the API at the address in
  `web/config.js` (default http://127.0.0.1:8000); `?api=<address>` in the page's address overrides it.

Run each in its own terminal:

    # 1. backend (API on http://127.0.0.1:8000, docs at /docs)
    cd backend
    python -m venv .venv && source .venv/bin/activate        (Windows: .venv\Scripts\activate)
    pip install -r requirements.txt
    python run.py

    # 2. frontend (web page on http://127.0.0.1:5173)
    python serve_web.py

Then open http://127.0.0.1:5173/. Any static file server works for the frontend; `serve_web.py` only needs Python. The
backend's first start downloads about 620 MB of NASA data (LOLA elevation models, SPICE kernels) and 14 months of Sun and
Earth positions from JPL Horizons; later starts skip what is already there. Details: [backend/README.md](backend/README.md).

To put it online, host the backend from the `Dockerfile` on any host with a persistent disk (a `fly.toml` for Fly.io is
included) and the frontend on any static host; see [Hosting](#hosting).

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
- `web/`        the frontend: `index.html`, `style.css`, `app.js` (asks the API and draws), `config.js` (the API address)
- `backend/`    the backend: data preparation (`skyline/prep`), the engine (`skyline/engine`), the API (`skyline/api`),
                tests and the NASA data manifest; see [backend/README.md](backend/README.md)
- `serve_web.py`   a small static server for the frontend
- `Dockerfile`, `fly.toml`   hosting for the backend

The original single-file app (in-browser engine, embedded data, `build/` pipeline) was retired when the page moved onto
the backend; it is in the git history at commit `afd9e78`.

## Accuracy
- Positions: JPL Horizons, cached by month (JPL SPICE DE440 as the fallback). Checked against JPL DE421 through SPICE at
  3,166 epochs and six sites: largest difference 0.00002 deg.
- Terrain tiers, shown beside every site: NASA's 5 m site maps where they exist (Shackleton rim, connecting ridge,
  de Gerlache rim, Chang'e 7 target, the pole), the 80 m south-pole model from 80 S, the 240 m model from 60 S, and a
  LOLA grid at 1/8 to 1/4 deg elsewhere. Every skyline is ray-cast on the server, 720 directions out to 330 km.
- The engine was ported from the original in-browser app and checked against it: identical mission verdicts, battery
  traces, Monte Carlo random numbers and design-lab results. See backend/README.md for every check.
- Shackleton rim, Connecting ridge, de Gerlache rim and Malapert Massif are placed on the highest ground within 600 m of their published coordinates.

## Limits
- Power is geometric: array output in full Sun x visible fraction of the solar disc x (1 AU / distance)^2, with 90% charge efficiency.
  Temperature, dust, array pointing limits and degradation are not modelled.
- Earth contact is line of sight to Earth's centre. Antenna pointing, link margin and ground-station scheduling are not modelled.
- Hourly sampling can miss a visibility window shorter than an hour.
- The landing-risk analysis samples the finest terrain at each touchdown cell every 30 m near the cell. Its spreads are assumptions the user can change. Its 95% interval reflects the finite number of simulated missions only, not errors in the terrain data or in those assumptions. Slope is measured over about 160 m, so boulders and small craters are not seen.
- With safe mode on, a larger array can occasionally fail where a smaller one passes, because less load is shed. The design lab then reports a size that passes, which may not be the very smallest.
- Design-lab masses are screening figures (output and energy divided by the W per kg and Wh per kg entered); structure, wiring, thermal control and margins are not included.
- The stress test applies one fault at a time and safe mode is a simple rule; neither models real flight software. Rise and set times shown in the status panel are refined by bisection.
- Coordinates of planned missions are published targets. Check them before relying on a result.

## Future directions
- **Mission digital twin**: several faults at once, scheduled activities, and a planner that chooses recovery actions (delay a high-power task, change the communication schedule).
- **Hazard-scale landing safety**: slope, roughness and boulders from the 5 m LOLA site models and LROC images.
- **Finer landing-risk terrain**: the Monte Carlo already uses the 5 m LOLA site models where they exist; next, LOLA's own height-error maps, so boulder- and crater-scale hazards count.
- **Relay satellites**: add orbiters (for example ESA's Lunar Pathfinder) as a second way to reach Earth, which matters most for far-side and crater-floor sites.
- **Rover traverses**: plan a path and timing that keep a rover in sunlight and in contact, instead of a single fixed point.
- **Thermal model**: surface and hardware temperature through the lunar day and night, which often limits a mission before power does.
- **Other places**: the Moon's north pole needs only the matching LOLA file; Mercury's poles and Mars would need new terrain and rotation models.
- **Learned surrogate**: a small neural network trained on the ray-cast results could give instant whole-region illumination maps. It only makes sense once the physics-based maps exist to train and check it against.

## Data and credits
- NASA GSFC PGDA LOLA elevation models (Barker et al. 2021): products 90 (80 m and 240 m south polar) and 78 (5 m site maps)
- LOLA-derived global grid and Moon mosaic: LLNL `ssa-data-lunar` (MIT)
- JPL Horizons: Sun and Earth positions
- JPL NAIF SPICE kernels (DE440, lunar orientation): fallback ephemeris and validation; DE421 for validation
- The full citation list is in backend/manifest.json and backend/README.md

## Use of AI
Code, tests and text were drafted with Claude (Anthropic) and reviewed with feedback from ChatGPT (OpenAI).

## Hosting
The submission needs a public link. The two parts are hosted separately.

**Backend** (needs a persistent disk for the NASA data), for example on Fly.io:

    fly launch --no-deploy --copy-config          # once: choose an app name and region
    fly volumes create skyline_data --size 3      # 3 GB for the NASA data and the cache
    fly secrets set SKYLINE_CORS_ORIGINS=https://<where-the-frontend-lives>   # optional: only that page may call the API
    fly deploy

The first start downloads the data (a few minutes); `/health` reports progress. Locally the server peaked at about
820 MB while serving every view (Monte Carlo included), so 2 GB of memory leaves room. The Dockerfile has not yet been
built and run end to end; test it locally with
`docker build -t lunar-skyline . && docker run -p 8000:8000 -v "$PWD/backend/data:/data" lunar-skyline`.

**Frontend** (static files only): set the backend's public address in `web/config.js`, then publish the `web/` folder on
any static host. Netlify and Cloudflare Pages can publish the `web/` folder directly. GitHub Pages needs a small Actions
workflow, because it only serves a branch's root or `/docs` folder on its own.
