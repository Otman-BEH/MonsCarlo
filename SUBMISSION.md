# Project page text (NASA Space Apps 2026)

Paste each block into the matching field. Replace everything in [brackets].

## Project name
Mons Carlo

## High-level project summary
Mons Carlo lets anyone stand on a landing site on the Moon and see where the Sun and the Earth sit against the real terrain horizon, for any date. It then answers the question a mission team actually has: will this lander have power and a radio link for its whole mission, and what are the options if the landing slips? A Python server does every calculation and serves the web page that draws the results; its API lets other apps and scripts ask the same questions. It combines Sun and Earth positions from NASA's JPL Horizons service, NASA's LOLA terrain down to 5 m resolution, an hour-by-hour battery and communication model, a search for alternative sites and dates, and a Monte Carlo test of what happens when the lander misses its target.

## Link to project demo
[Public link to the 7-slide deck or a 30-second video]

## Link to final project
[Public link to the hosted app] · Code: [public repository link]

## Detailed project description
**What it does**
- *See the site.* A first-person view of the terrain from the lander's mast, with cast shadows, and the Sun and Earth at true size. A sky chart, a live shadow map of the south pole, a 3D globe of the whole Moon lit from the true Sun direction, countdowns to sunset and Earthset, and a timeline of both bodies against the horizon.
- *Plan a mission.* The user enters mission length, solar array output, loads, battery, reserve and the longest acceptable radio gap. The tool simulates the battery every hour and reports whether the mission passes, is marginal (it only works if the terrain data is perfect) or fails, with the reason.
- *Mission Rescue.* The user applies a schedule slip to a plan. The tool ranks other sites and landing times that still meet the needs.
- *Design lab.* The tool works backwards from the mission to the hardware: it maps every solar-array and battery pair that survives, marks the lightest, lists concrete fixes for a failing design, and searches landing dates for the one that needs the least hardware.
- *Stress test.* The user injects a fault (for example the solar array loses 30% of its output on day 3) and sees whether the lander survives, with or without a safe mode.
- *Landing risk.* A Monte Carlo simulation varies the touchdown point, landing time, terrain height and hardware performance across thousands of missions, and counts ground that is too steep as a failure. It reports the chance of success with a 95% interval, why missions fail, what drives the risk, where a touchdown still works, and a better aim point when one holds up on a separate set of random draws. Every assumption is adjustable.
- *Guided tour.* Eight steps walk a first-time visitor through the tool.
- *Why the south pole?* A view for teachers and the public: Apollo 11's sky beside Shackleton rim's at the same moment, live figures for both, and an axis-tilt diagram that explains why the Sun never climbs at the pole.
- *Share.* One button copies a link that reopens the same site, time, mission and comparison. The time series and the mission report can be saved as files.
- *Compare sites and dates.* One horizon panorama per site for the same instant, side-by-side statistics and a twelve-month calendar of landing days that meet the mission needs.

**How it works**
- Sun and Earth positions come from NASA's JPL Horizons service as Moon-fixed vectors (so libration and the offset between the Moon's centre and the site are included), fetched month by month and cached, with JPL's SPICE DE440 kernels as the fallback. Against JPL's DE421 ephemeris through SPICE the largest difference is 0.00002 degrees over 3,166 dates at six sites.
- Skylines are ray-cast on the server from NASA's LOLA elevation models in 720 directions out to 330 km: 5 m site maps where they exist, the 80 m south-pole model, the 240 m model from 60 degrees south, and a global grid elsewhere.
- 888 automatic tests cover geometry, terrain, the battery model and the Monte Carlo.

**Who it is for**
Mission planners who need a fast first answer when a site or date changes, and educators and the public who want to see why the lunar south pole is hard.

**Limits**
Power is geometric (no thermal or dust model). Earth contact means line of sight to Earth's centre. The Monte Carlo spreads are stated, adjustable assumptions, and its interval reflects simulation noise only. Slope is measured over about 160 m. Coordinates of planned missions are published targets.

**Tools and languages**
JavaScript, HTML and CSS (no framework), Canvas 2D; Python (numpy, scipy, tifffile) for data preparation; SPICE (spiceypy) for validation; Node.js for tests; Jupyter for the walk-through notebook.

## NASA data
- LOLA south-pole elevation model LDEM_80S_80MPP_ADJ, NASA GSFC Planetary Geodynamics Data Archive ("A New View of the Lunar South Pole from LOLA", Barker et al.): terrain, horizons, shadow map, surface view.
- JPL DE421 planetary and lunar ephemeris and the lunar orientation kernel, through SPICE: validation of Sun and Earth positions.
- LOLA-derived global elevation grid and LROC-based Moon mosaic (packaged in LLNL's ssa-data-lunar): coarse terrain away from the south pole and the whole-Moon map.
- JPL Horizons System: the source of Sun and Earth positions, fetched month by month by the backend and checked against JPL SPICE.
- LROC Quickmap and Moon Trek: reference tools named in the challenge, used to understand what the tool should make easier.

## Space Agency Partner and other data
- No Space Agency Partner dataset was used. [Edit if you used the CSA Moon Exploration portal.]
- LLNL ssa-data-lunar (MIT licence): packaged LOLA grid and Moon mosaic.

## Use of artificial intelligence
The code, tests, notebook, slide text and this description were drafted with Claude (Anthropic), with review feedback from ChatGPT (OpenAI). [Describe what you checked, changed and decided yourself.] No AI-generated images, video or audio are used; all pictures are screenshots of the tool, drawn from NASA data. No NASA logos or branding appear in AI-generated content.

## References
- Mazarico et al. (2011), Illumination conditions of the lunar polar regions using LOLA topography, Icarus 211.
- Barker et al. (2021), Improved LOLA elevation maps for south pole landing sites, Planetary and Space Science 203.
- NASA GSFC PGDA, https://pgda.gsfc.nasa.gov/products/90
- JPL Horizons System, https://ssd.jpl.nasa.gov/horizons/
