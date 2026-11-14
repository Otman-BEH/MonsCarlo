# Project page text (NASA Space Apps 2026)

Paste each block into the matching field. Replace everything in [brackets].

## Project name
Lunar Skyline

## High-level project summary
Lunar Skyline lets anyone stand on a landing site on the Moon and see where the Sun and the Earth sit against the real terrain horizon, for any date. It then answers the question a mission team actually has: will this lander have power and a radio link for its whole mission, and what are the options if the landing slips? The tool runs in a browser from a single file. It combines an ephemeris engine checked against JPL data, NASA's LOLA terrain, an hour-by-hour battery and communication model, a search for alternative sites and dates, and a Monte Carlo test of what happens when the lander misses its target.

## Link to project demo
[Public link to the 7-slide deck or a 30-second video]

## Link to final project
[Public GitHub Pages link to index.html] · Code: [public repository link]

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
- Sun and Earth positions are computed in the browser with the Astronomy Engine library and the IAU model of the Moon's rotation, including libration and the offset between the Moon's centre and the site. The largest difference from JPL's DE421 ephemeris (through SPICE) is 0.004 degrees over 3,166 dates at six sites, and an independent check against NASA's live JPL Horizons service agrees to 0.004 degrees over 1,260 comparisons.
- Horizons are ray-cast from NASA's LOLA south-pole elevation model: at 80 m resolution in 720 directions for the listed south-pole sites, and in the browser for any other point.
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
- JPL Horizons System: independent validation of Sun and Earth positions seen from the lunar surface (`build/horizons_check.js`).
- LROC Quickmap and Moon Trek: reference tools named in the challenge, used to understand what the tool should make easier.

## Space Agency Partner and other data
- No Space Agency Partner dataset was used. [Edit if you used the CSA Moon Exploration portal.]
- Astronomy Engine by Don Cross (MIT licence): ephemeris calculations.
- LLNL ssa-data-lunar (MIT licence): packaged LOLA grid and Moon mosaic.

## References
- Mazarico et al. (2011), Illumination conditions of the lunar polar regions using LOLA topography, Icarus 211.
- Barker et al. (2021), Improved LOLA elevation maps for south pole landing sites, Planetary and Space Science 203.
- NASA GSFC PGDA, https://pgda.gsfc.nasa.gov/products/90
- JPL Horizons System, https://ssd.jpl.nasa.gov/horizons/
- Astronomy Engine, https://github.com/cosinekitty/astronomy
